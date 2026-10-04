import type { OnboardingUI } from '../../src/application/onboarding/index.js';
/** CONTRACT ONLY: deterministic dialog replies, not a real terminal or human-operated RPC test. */
export class ContractUI implements OnboardingUI {
  readonly calls: Array<{ method: 'confirm' | 'select' | 'input'; title: string; message?: string; choices?: string[] }> = [];
  readonly notifications: string[] = [];
  cancelAt?: number;
  selectAnswer?: (title: string, choices: string[]) => string | undefined;
  inputAnswer?: (title: string, placeholder?: string) => string | undefined;
  confirmAnswer?: (title: string, message: string) => boolean | Promise<boolean>;
  private cancelled(method: 'confirm' | 'select' | 'input', title: string, extra = {}): boolean {
    this.calls.push({ method, title, ...extra });
    return this.calls.length === this.cancelAt;
  }
  async confirm(title: string, message: string): Promise<boolean> {
    if (this.cancelled('confirm', title, { message })) return false;
    return this.confirmAnswer ? this.confirmAnswer(title, message) : true;
  }
  async select(title: string, choices: string[]): Promise<string | undefined> {
    if (this.cancelled('select', title, { choices })) return undefined;
    return this.selectAnswer ? this.selectAnswer(title, choices) : choices[0];
  }
  async input(title: string, placeholder?: string): Promise<string | undefined> {
    if (this.cancelled('input', title)) return undefined;
    return this.inputAnswer ? this.inputAnswer(title, placeholder) : '';
  }
  notify(message: string): void { this.notifications.push(message); }
}
