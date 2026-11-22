/**
 * Emails Finken sends: confirming an address, and resetting a password.
 *
 * - With SMTP_URL set (required in staging and production), they go
 *   through that mail server, which can be one you run yourself.
 * - Without it (development and tests), nothing leaves the computer: the
 *   email is written to the server's log, and kept in a short list that
 *   only a development server shows (GET /v1/dev/mail).
 *
 * Emails never contain amounts or records, only the link.
 */
import nodemailer from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** The link in the email, kept separately for the development list. */
  link: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
  /** Development only: the most recent emails. */
  recent?(): Email[];
}

export function logMailer(log: (line: string) => void = (line) => console.log(line)): Mailer {
  const kept: Email[] = [];
  return {
    async send(email) {
      kept.unshift(email);
      kept.length = Math.min(kept.length, 50);
      log(`[email to ${email.to}] ${email.subject}: ${email.link}`);
    },
    recent: () => [...kept],
  };
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(email) {
      await transport.sendMail({ from, to: email.to, subject: email.subject, text: email.text });
    },
  };
}

export const verifyEmail = (to: string, name: string, link: string): Email => ({
  to,
  link,
  subject: 'Confirm your email for Finken',
  text: `Hello${name ? ` ${name}` : ''},\n\nConfirm this is your email address for Finken by opening this link:\n\n${link}\n\nThe link works once, for 48 hours. If you did not create a Finken account, you can ignore this email.\n\nFinken`,
});

export const resetEmail = (to: string, link: string): Email => ({
  to,
  link,
  subject: 'Set a new Finken password',
  text: `Someone asked to set a new password for the Finken account with this email.\n\nTo choose a new password, open this link:\n\n${link}\n\nThe link works once, for 30 minutes, and signs you out of every device. If it was not you, ignore this email: your password has not changed.\n\nFinken`,
});
