import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
	plugins: [
		webExtension({
			manifest: "manifest.json",

			webExtConfig: {
				startUrl: "https://web.whatsapp.com/",
				target: "chromium",
			},
		}),
	],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		minify: false,
	},
	server: {
		port: 5173,
		strictPort: true,
		hmr: {
			port: 5173,
		},
	},
});
