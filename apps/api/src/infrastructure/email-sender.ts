export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Logs the email instead of sending it. Real production email requires an
 * account with a provider (Resend, SES, etc.) that only the deployer can
 * set up — this keeps magic-link login fully usable in dev/test without
 * that dependency, and gives a single seam to swap in a real provider later.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[email:dev] to=${message.to} subject="${message.subject}"\n${message.text}`);
    await Promise.resolve();
  }
}
