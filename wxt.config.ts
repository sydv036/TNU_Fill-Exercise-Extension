import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "TNU Gemini Study Assistant",
    description: "Hỗ trợ luyện tập Moodle TNU với Gemini và luôn dừng trước bước nộp bài.",
    version: "0.1.0",
    minimum_chrome_version: "114",
    permissions: ["storage", "tabs", "sidePanel", "notifications"],
    host_permissions: [
      "https://tnu.aum.edu.vn/*",
      "https://generativelanguage.googleapis.com/*"
    ],
    action: {
      default_title: "Mở TNU Gemini Assistant"
    },
    side_panel: {
      default_path: "sidepanel.html"
    },
    icons: {
      "16": "icon-16.png",
      "48": "icon-48.png",
      "128": "icon-128.png"
    }
  }
});
