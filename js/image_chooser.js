import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { openChooser, closeChooser, isChooserOpen } from "./image_chooser_preview.js";
import { send_cancel, send_onstart, skip_next_restart_message } from "./image_chooser_messaging.js";

function ensureSettings() {
    if (!app?.ui?.settings) return;
    app.ui.settings.addSetting({
        id: "ImageChooser.alert",
        name: "Image Chooser: play alert sound",
        type: "boolean",
        defaultValue: true,
    });
    app.ui.settings.addSetting({
        id: "ImageChooser.hotkeys",
        name: "Image Chooser: enable overlay hotkeys",
        type: "boolean",
        defaultValue: true,
    });
    app.ui.settings.addSetting({
        id: "ImageChooser.thumbnailRightClick",
        name: "Thumbnail Right Click",
        type: "combo",
        options: ["Browser Default", "ComfyUI Node", "Open Image"],
        defaultValue: "Browser Default",
        tooltip:
            "Choose what happens when right clicking a thumbnail. Browser Default opens your browser's context menu, ComfyUI Node opens the node's context menu, and Open Image opens the image in a new tab.",
    });
}

const alertAudio = new Audio("extensions/image-chooser-classic/ding.mp3");

app.registerExtension({
    name: "cg.custom.image_chooser.v3",
    init() {
        window.addEventListener("beforeunload", () => {
            if (isChooserOpen()) {
                send_cancel();
            }
        });
    },
    setup() {
        ensureSettings();

        api.addEventListener("cg-image-chooser-classic-open", (event) => {
            if (app.ui.settings.getSettingValue("ImageChooser.alert", true)) {
                alertAudio.currentTime = 0;
                alertAudio.play().catch(() => {});
            }
            openChooser(event);
        });

        api.addEventListener("execution_start", () => {
            if (send_onstart()) {
                closeChooser("execution_start");
            }
        });
        api.addEventListener("execution_error", () => closeChooser("execution_error"));
        api.addEventListener("execution_success", () => closeChooser("execution_success"));
        api.addEventListener("execution_interrupted", () => closeChooser("execution_interrupted"));
    },
    beforeRegisterNodeDef(nodeType, _nodeData, _app) {
        if (!nodeType?.prototype) return;
        if (["Image Chooser", "Simple Chooser", "Preview Chooser"].includes(nodeType.comfyClass)) {
            nodeType.prototype.isImageChooser = true;
            const originalQueue = nodeType.prototype.onQueue;
            nodeType.prototype.onQueue = function (...args) {
                skip_next_restart_message();
                return originalQueue?.apply(this, args);
            };
        }
    },
});
