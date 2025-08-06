import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [
		tsconfigPaths(),
		webExtension({
			manifest: "manifest.json",

			webExtConfig: {
				startUrl: "https://web.whatsapp.com/",
				target: "chromium",
				profileCreateIfMissing: true,
				chromiumProfile: "./extension-storage",
				keepProfileChanges: true,
			},
		}),
	],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		minify: false,
		sourcemap: true,
	},
	server: {
		port: 5173,
		strictPort: true,
		hmr: {
			port: 5173,
		},
	},
});
