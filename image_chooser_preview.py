from __future__ import annotations

import random
from typing import Dict, List, Optional, Sequence, Union

import torch

from server import PromptServer
from nodes import PreviewImage
from comfy.model_management import InterruptProcessingException

from .image_chooser_server import MessageBroker, Cancelled


def _flatten_latents(latents_in: Optional[Sequence[Dict]]) -> List[Dict[str, torch.Tensor]]:
    flat_latents = []
    if latents_in is not None:
        for latent in latents_in:
            samples = latent.get("samples")
            if samples is None:
                continue
            for i in range(samples.shape[0]):
                single = {"samples": samples[i].unsqueeze(0)}
                if "noise_mask" in latent:
                    nm = latent["noise_mask"]
                    if nm.shape[0] == samples.shape[0]:
                        single["noise_mask"] = nm[i].unsqueeze(0)
                    else:
                        single["noise_mask"] = nm
                flat_latents.append(single)
    return flat_latents


class BaseChooser(PreviewImage):
    CATEGORY = "image_chooser"
    DESCRIPTION = "Pauses the workflow so you can choose images from a batch and forward matching outputs."
    INPUT_IS_LIST = True
    OUTPUT_NODE = False
    FUNCTION = "func"

    _last_ic: Dict[str, float] = {}
    _last_image_fingerprint: Dict[str, object] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (
                    [
                        "Always pause",
                        "Repeat last selection",
                        "Repeat last cached selection",
                        "Only pause if batch",
                        "Progress first pick",
                        "Pass through",
                        "Take First n",
                        "Take Last n",
                    ],
                    {},
                ),
                "count": ("INT", {"default": 1, "min": 1, "max": 999, "step": 1}),
            },
            "optional": {
                "images": ("IMAGE",),
                "latents": ("LATENT",),
                "masks": ("MASK",),
                "segs": ("SEGS",),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, id, **kwargs):
        mode = kwargs.get("mode", ["Always pause"])
        node_id = str(id[0])
        if mode[0] not in ("Repeat last selection", "Repeat last cached selection") or node_id not in cls._last_ic:
            cls._last_ic[node_id] = random.random()
        return cls._last_ic[node_id]

    def chooser_type(self) -> str:
        return "single"

    def expects_segments(self) -> bool:
        return False

    def notify_frontend(self, context: Dict[str, object]) -> None:
        PromptServer.instance.send_sync("cg-image-chooser-classic-open", context)

    def func(self, id, **kwargs):
        count = int(kwargs.pop("count", [1])[0])
        mode = kwargs.pop("mode", ["Always pause"])[0]

        unique_id = str(id[0])
        display_id = unique_id.split(":", 1)[0]
        MessageBroker.bind_display_id(display_id, unique_id)

        stash = MessageBroker.stash_for(unique_id)

        if "images" in kwargs:
            stash["images"] = kwargs["images"]
            stash["latents"] = kwargs.get("latents")
            stash["masks"] = kwargs.get("masks")
            stash["segs"] = kwargs.get("segs")
        else:
            kwargs["images"] = stash.get("images")
            kwargs["latents"] = stash.get("latents")
            kwargs["masks"] = stash.get("masks")
            kwargs["segs"] = stash.get("segs")

        doing_segs = kwargs.get("segs") is not None

        if kwargs.get("images") is None:
            raise RuntimeError(
                "Image Chooser requires an 'images' input. Connect an IMAGE output to this node."
            )

        images_in = kwargs.pop("images")
        if not images_in:
            raise RuntimeError("Image Chooser received an empty list of images.")
            
        latents_in = kwargs.pop("latents", None)
        masks_in = kwargs.pop("masks", None)
        segs_in = kwargs.pop("segs", None)

        flat_images = []
        for img in images_in:
            for i in range(img.shape[0]):
                flat_images.append(img[i])
        
        flat_masks = []
        if masks_in and masks_in[0] is not None:
            for m in masks_in:
                if m is None: continue
                for i in range(m.shape[0]):
                    flat_masks.append(m[i])
            
        flat_latents = _flatten_latents(latents_in)

        batch = len(flat_images)

        for key in list(kwargs.keys()):
            kwargs[key] = kwargs[key][0]

        image_fingerprint = None
        if mode == "Repeat last cached selection":
            image_fingerprint = tuple((tuple(img.shape), img.sum().item()) for img in flat_images)

        selection: Optional[List[int]] = None
        last_selection = MessageBroker.get_last_selection(unique_id)

        if mode == "Repeat last selection" and last_selection:
            selection = list(last_selection)
        elif mode == "Repeat last cached selection":
            if last_selection and self._last_image_fingerprint.get(unique_id) == image_fingerprint:
                selection = list(last_selection)
        elif mode == "Pass through":
            selection = list(range(batch))
        elif mode == "Take First n":
            selection = list(range(min(count, batch)))
        elif mode == "Take Last n":
            start = max(0, batch - count)
            selection = list(range(start, batch))
        elif mode == "Only pause if batch" and batch <= 1:
            selection = [0]

        preview_payload = flat_images
        ret = self.save_images(images=preview_payload, **kwargs)

        context = {
            "unique_id": unique_id,
            "display_id": display_id,
            "chooser_type": self.chooser_type(),
            "mode": mode,
            "count": count,
            "image_count": batch,
            "progress_first_pick": mode == "Progress first pick",
            "urls": ret["ui"]["images"],
            "has_latents": len(flat_latents) > 0,
            "has_masks": len(flat_masks) > 0,
            "has_segs": doing_segs,
        }

        if selection is None:
            self.notify_frontend(context)
            try:
                selection = MessageBroker.wait_for_message(unique_id, as_list=True)
            except Cancelled:
                raise InterruptProcessingException()

        selection = [idx for idx in selection if idx >= 0]
        MessageBroker.set_last_selection(unique_id, selection)
        if image_fingerprint is not None:
            self._last_image_fingerprint[unique_id] = image_fingerprint

        all_segments = []
        segs_shape = None
        if doing_segs and segs_in:
            for segs_tuple in segs_in:
                if segs_tuple and len(segs_tuple) == 2:
                    if segs_shape is None:
                        segs_shape = segs_tuple[0]
                    all_segments.extend(segs_tuple[1])

        segs_out = None
        if doing_segs and segs_in and segs_shape is not None:
            selected_segs = [all_segments[i] for i in selection if i < len(all_segments)]
            segs_out = (segs_shape, selected_segs)

        return self._build_outputs(
            flat_images=flat_images,
            flat_latents=flat_latents,
            flat_masks=flat_masks,
            selection=selection,
            segs_out=segs_out,
        )

    def tensor_bundle(self, flat_tensors: Optional[List[torch.Tensor]], picks: Sequence[int]) -> Optional[Union[torch.Tensor, List[torch.Tensor]]]:
        if not flat_tensors or len(picks) == 0:
            return None
        collect = [flat_tensors[index % len(flat_tensors)].unsqueeze(0) for index in picks]
        try:
            return torch.cat(collect, dim=0)
        except RuntimeError:
            return collect

    def latent_bundle(
        self, flat_latents: Optional[List[Dict[str, torch.Tensor]]], picks: Sequence[int]
    ) -> Optional[Union[Dict[str, torch.Tensor], List[Dict[str, torch.Tensor]]]]:
        if not flat_latents or len(picks) == 0:
            return None
            
        selected_samples = []
        selected_masks = []
        has_mask = False
        
        for index in picks:
            latent = flat_latents[index % len(flat_latents)]
            selected_samples.append(latent["samples"])
            if "noise_mask" in latent:
                has_mask = True
                selected_masks.append(latent["noise_mask"])
                
        try:
            res = {}
            if selected_samples:
                res["samples"] = torch.cat(selected_samples, dim=0)
            if has_mask and len(selected_masks) == len(selected_samples):
                res["noise_mask"] = torch.cat(selected_masks, dim=0)
            return res if res else None
        except RuntimeError:
            return [flat_latents[index % len(flat_latents)] for index in picks]

    def _build_outputs(
        self,
        *,
        flat_images: List[torch.Tensor],
        flat_latents: List[Dict[str, torch.Tensor]],
        flat_masks: List[torch.Tensor],
        selection: Sequence[int],
        segs_out: Optional[tuple] = None,
    ):
        images = self.tensor_bundle(flat_images, selection)
        latents = self.latent_bundle(flat_latents, selection)
        masks = self.tensor_bundle(flat_masks, selection)
        selection_str = ",".join(str(i) for i in selection)
        return (images, latents, masks, selection_str, segs_out)


class PreviewAndChooseClassic(BaseChooser):
    RETURN_TYPES = ("IMAGE", "LATENT", "MASK", "STRING", "SEGS")
    RETURN_NAMES = ("images", "latents", "masks", "selected", "segs")
    DESCRIPTION = "Inline classic chooser widget that pauses execution for manual image selection."

    def chooser_type(self) -> str:
        return "classic_widget"

    def notify_frontend(self, context: Dict[str, object]) -> None:
        PromptServer.instance.send_sync("cg-image-chooser-classic-widget-channel", context)


class PreviewAndChoose(BaseChooser):
    RETURN_TYPES = ("IMAGE", "LATENT", "MASK", "STRING", "SEGS")
    RETURN_NAMES = ("images", "latents", "masks", "selected", "segs")
    DESCRIPTION = "Overlay chooser that pauses execution so you can select one or more images."


class SimpleChooser(PreviewAndChoose):
    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("images", "latents")
    DESCRIPTION = "Lightweight chooser that returns selected images and latents only."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"images": ("IMAGE",)},
            "optional": {"latents": ("LATENT",)},
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "id": "UNIQUE_ID"},
        }

    def func(self, **kwargs):
        outputs = super().func(**kwargs)
        return outputs[0], outputs[1]


class PreviewAndChooseDouble(BaseChooser):
    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("positive", "negative")
    DESCRIPTION = "Split selected batch items into positive and negative latent groups."

    def chooser_type(self) -> str:
        return "double"

    def _build_outputs(
        self,
        *,
        flat_images: List[torch.Tensor],
        flat_latents: List[Dict[str, torch.Tensor]],
        flat_masks: List[torch.Tensor],
        selection: Sequence[int],
        segs_out: Optional[tuple] = None,
    ):
        if -1 in selection:
            divider = selection.index(-1)
            positive = selection[:divider]
            negative = selection[divider + 1 :]
        else:
            positive = selection
            negative = []

        latents_positive = self.latent_bundle(flat_latents, positive)
        latents_negative = self.latent_bundle(flat_latents, negative)
        return (latents_positive, latents_negative)
