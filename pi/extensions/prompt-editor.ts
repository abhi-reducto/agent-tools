/**
 * Prompt-style Editor Extension
 *
 * Adds a dimmed \`>\` prompt before the cursor when the editor is empty,
 * giving a Claude Code / terminal prompt feel.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

class PromptEditor extends CustomEditor {
	render(width: number): string[] {
		const lines = super.render(width);
		// Only augment when the editor has no text
		if (this.getText() !== "") return lines;

		// Find the first content line that contains the cursor marker
		// and prepend the prompt before it.
		for (let i = 1; i < lines.length - 1; i++) {
			const line = lines[i]!;
			const markerIdx = line.indexOf(CURSOR_MARKER);
			if (markerIdx !== -1) {
				const prompt = this.theme.borderColor("> ");
				lines[i] = line.slice(0, markerIdx) + prompt + line.slice(markerIdx);
				break;
			}
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setEditorComponent((tui, theme, kb) => new PromptEditor(tui, theme, kb));
		}
	});
}
