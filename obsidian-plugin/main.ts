import { App, Modal, Notice, Plugin, TFile } from "obsidian";
import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";

const PYTHON_BIN = join(homedir(), ".second-brain", "venv", "bin", "python");
const SEARCH_SCRIPT = join(homedir(), ".second-brain", "search.py");
const N_RESULTS = 8;
const TIMEOUT_MS = 30_000;

interface SearchResult {
	path: string;
	snippet: string;
	distance: number;
}

function runSearch(query: string): Promise<SearchResult[]> {
	return new Promise((resolve, reject) => {
		execFile(
			PYTHON_BIN,
			[SEARCH_SCRIPT, query, String(N_RESULTS), "--json"],
			{ timeout: TIMEOUT_MS },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr?.trim() || error.message));
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					if (parsed && parsed.error) {
						reject(new Error(parsed.error));
						return;
					}
					resolve(parsed as SearchResult[]);
				} catch (e) {
					reject(new Error("Invalid response from search.py: " + stdout));
				}
			}
		);
	});
}

class SecondBrainSearchModal extends Modal {
	private resultsEl: HTMLElement;
	private inputEl: HTMLInputElement;

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Search your Second Brain" });

		const searchRow = contentEl.createDiv({ cls: "sb-search-row" });
		searchRow.style.display = "flex";
		searchRow.style.gap = "8px";

		this.inputEl = searchRow.createEl("input", {
			type: "text",
			placeholder: "What are you looking for?",
		});
		this.inputEl.style.flexGrow = "1";
		this.inputEl.focus();

		const button = searchRow.createEl("button", { text: "Search" });

		this.resultsEl = contentEl.createDiv({ cls: "sb-search-results" });
		this.resultsEl.style.marginTop = "16px";

		const doSearch = () => this.handleSearch(this.inputEl.value.trim());
		button.addEventListener("click", doSearch);
		this.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") doSearch();
		});
	}

	async handleSearch(query: string): Promise<void> {
		if (!query) return;
		this.resultsEl.empty();
		this.resultsEl.createEl("p", { text: "Searching...", cls: "sb-search-status" });

		try {
			const results = await runSearch(query);
			this.renderResults(results);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.resultsEl.empty();
			this.resultsEl.createEl("p", { text: `Error: ${message}` });
			new Notice("Second Brain Search: " + message);
		}
	}

	renderResults(results: SearchResult[]): void {
		this.resultsEl.empty();
		if (results.length === 0) {
			this.resultsEl.createEl("p", { text: "No results found." });
			return;
		}

		for (const result of results) {
			const item = this.resultsEl.createDiv({ cls: "sb-search-item" });
			item.style.padding = "8px 0";
			item.style.borderBottom = "1px solid var(--background-modifier-border)";
			item.style.cursor = "pointer";

			item.createEl("div", { text: result.path, cls: "sb-search-item-title" }).style.fontWeight =
				"600";
			item.createEl("div", {
				text: result.snippet.replace(/\s+/g, " ").slice(0, 220),
				cls: "sb-search-item-snippet",
			}).style.opacity = "0.75";

			item.addEventListener("click", () => this.openResult(result.path));
		}
	}

	async openResult(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
			this.close();
		} else {
			new Notice("Note not found in vault: " + path);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class SecondBrainSearchPlugin extends Plugin {
	async onload(): Promise<void> {
		this.addRibbonIcon("search", "Search your Second Brain", () => {
			new SecondBrainSearchModal(this.app).open();
		});

		this.addCommand({
			id: "open-second-brain-search",
			name: "Search your Second Brain",
			callback: () => {
				new SecondBrainSearchModal(this.app).open();
			},
		});
	}
}
