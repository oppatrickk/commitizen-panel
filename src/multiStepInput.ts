import * as vscode from 'vscode';

/**
 * Multi-step QuickInput helper.
 *
 * Adapted from the `quickinput-sample` in microsoft/vscode-extension-samples. A
 * hand-rolled chain of `await showQuickPick()` calls cannot offer a back button
 * or step counters, which is exactly what a five-step commit wizard needs.
 */

export class InputFlowAction {
	static readonly back = new InputFlowAction();
	static readonly cancel = new InputFlowAction();
	static readonly resume = new InputFlowAction();
}

export type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface QuickPickParameters<T extends vscode.QuickPickItem> {
	title: string;
	step: number;
	totalSteps: number;
	items: T[];
	activeItem?: T;
	placeholder?: string;
	matchOnDescription?: boolean;
	ignoreFocusOut?: boolean;
}

interface InputBoxParameters {
	title: string;
	step: number;
	totalSteps: number;
	value: string;
	prompt: string;
	placeholder?: string;
	validate?: (value: string) => vscode.InputBoxValidationMessage | string | undefined;
	ignoreFocusOut?: boolean;
}

export class MultiStepInput {
	static run(start: InputStep): Promise<void> {
		return new MultiStepInput().stepThrough(start);
	}

	private current?: vscode.QuickInput;
	private steps: InputStep[] = [];

	private async stepThrough(start: InputStep): Promise<void> {
		let step: InputStep | void = start;

		while (step) {
			this.steps.push(step);
			if (this.current) {
				this.current.enabled = false;
				this.current.busy = true;
			}

			try {
				step = await step(this);
			} catch (error) {
				if (error === InputFlowAction.back) {
					this.steps.pop();
					step = this.steps.pop();
				} else if (error === InputFlowAction.resume) {
					step = this.steps.pop();
				} else if (error === InputFlowAction.cancel) {
					step = undefined;
				} else {
					throw error;
				}
			}
		}

		this.current?.dispose();
	}

	async showQuickPick<T extends vscode.QuickPickItem>({
		title,
		step,
		totalSteps,
		items,
		activeItem,
		placeholder,
		matchOnDescription,
		ignoreFocusOut,
	}: QuickPickParameters<T>): Promise<T> {
		const disposables: vscode.Disposable[] = [];

		try {
			return await new Promise<T>((resolve, reject) => {
				const input = vscode.window.createQuickPick<T>();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.items = items;
				input.ignoreFocusOut = ignoreFocusOut ?? false;
				input.matchOnDescription = matchOnDescription ?? true;
				if (placeholder) {
					input.placeholder = placeholder;
				}
				if (activeItem) {
					input.activeItems = [activeItem];
				}
				if (step > 1) {
					input.buttons = [vscode.QuickInputButtons.Back];
				}

				disposables.push(
					input.onDidTriggerButton((button) => {
						if (button === vscode.QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						}
					}),
					input.onDidAccept(() => {
						const selected = input.selectedItems[0];
						if (selected) {
							resolve(selected);
						}
					}),
					input.onDidHide(() => reject(InputFlowAction.cancel)),
				);

				this.current?.dispose();
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach((disposable) => disposable.dispose());
		}
	}

	async showInputBox({
		title,
		step,
		totalSteps,
		value,
		prompt,
		placeholder,
		validate,
		ignoreFocusOut,
	}: InputBoxParameters): Promise<string> {
		const disposables: vscode.Disposable[] = [];

		try {
			return await new Promise<string>((resolve, reject) => {
				const input = vscode.window.createInputBox();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.value = value;
				input.prompt = prompt;
				input.ignoreFocusOut = ignoreFocusOut ?? false;
				if (placeholder) {
					input.placeholder = placeholder;
				}
				if (step > 1) {
					input.buttons = [vscode.QuickInputButtons.Back];
				}

				const check = (candidate: string): boolean => {
					const problem = validate?.(candidate);
					if (!problem) {
						input.validationMessage = undefined;
						return true;
					}

					input.validationMessage = problem;
					// A warning explains itself but must not block progress.
					return typeof problem !== 'string' && problem.severity === vscode.InputBoxValidationSeverity.Warning;
				};

				disposables.push(
					input.onDidTriggerButton((button) => {
						if (button === vscode.QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						}
					}),
					input.onDidChangeValue((candidate) => check(candidate)),
					input.onDidAccept(() => {
						if (check(input.value)) {
							resolve(input.value);
						}
					}),
					input.onDidHide(() => reject(InputFlowAction.cancel)),
				);

				this.current?.dispose();
				this.current = input;
				this.current.show();
				check(value);
			});
		} finally {
			disposables.forEach((disposable) => disposable.dispose());
		}
	}
}
