export type TransactionalTemplate =
  | "payment_receipt"
  | "payment_success"
  | "payment_failure"
  | "payout_update"
  | "invoice_reminder"
  | "payment_link_reminder"
  | "payment_failure_recovery"
  | "support_reply"
  | "support_receipt"
  | "team_invitation"
  | "admin_test"
  | "admin_broadcast";

export type TransactionalEmailContent = {
  subject: string;
  text: string;
  html: string;
};

export type TransactionalEmailPayload = Record<string, string | number | null>;

function value(payload: TransactionalEmailPayload, key: string, fallback = ""): string {
  const item = payload[key];
  return item === undefined || item === null ? fallback : String(item);
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function approvedDeploymentUrl(input: string): string | null {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  try {
    const deployment = new URL(configured);
    const url = new URL(input);
    if (deployment.protocol !== "https:" || url.protocol !== "https:" ||
      deployment.hostname.endsWith(".replit.dev") || deployment.hostname.endsWith(".repl.co") ||
      ["localhost", "127.0.0.1"].includes(deployment.hostname) ||
      url.origin !== deployment.origin) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function approvedAppPath(path: string): string | null {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  try {
    return approvedDeploymentUrl(new URL(path, configured).toString());
  } catch {
    return null;
  }
}

function branded(subject: string, paragraphs: string[], link?: { label: string; href: string }): TransactionalEmailContent {
  const safeSubject = escapeHtml(subject);
  const safeParagraphs = paragraphs.map((paragraph) => `<p style="margin:0 0 16px;color:#40564e;line-height:1.65">${escapeHtml(paragraph)}</p>`).join("");
  const linkMarkup = link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#294c43;color:#fffdf8;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(link.label)}</a></p>`
    : "";
  const contactUrl = approvedAppPath("/contact");
  const privacyUrl = approvedAppPath("/privacy");
  const termsUrl = approvedAppPath("/terms");
  const footerLinks = [
    contactUrl ? `<a href="${escapeHtml(contactUrl)}" style="color:#294c43">Contact Greenpay</a>` : "",
    privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" style="color:#294c43">Privacy</a>` : "",
    termsUrl ? `<a href="${escapeHtml(termsUrl)}" style="color:#294c43">Terms</a>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const text = [
    "Greenpay", "", subject, "", ...paragraphs,
    ...(link ? ["", `${link.label}: ${link.href}`] : []),
    "", "Need help? Contact Greenpay through the app.",
    ...(contactUrl ? [`Contact: ${contactUrl}`] : []),
    ...(privacyUrl ? [`Privacy: ${privacyUrl}`] : []),
    ...(termsUrl ? [`Terms: ${termsUrl}`] : []),
    "", "Greenpay · Payments with clarity",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f3eb;font-family:Arial,sans-serif"><main style="max-width:600px;margin:32px auto;background:#fffdf8;border:1px solid #e4e1d7;border-radius:16px;overflow:hidden"><header style="padding:24px 32px;background:#294c43;color:#fffdf8;font-size:22px;font-weight:700;letter-spacing:-.03em">greenpay<span style="color:#dfbd79">.</span></header><section style="padding:32px"><h1 style="margin:0 0 22px;color:#263d37;font-size:24px">${safeSubject}</h1>${safeParagraphs}${linkMarkup}<footer style="margin-top:32px;padding-top:20px;border-top:1px solid #e4e1d7;color:#71817b;font-size:12px;line-height:1.7"><p style="margin:0 0 8px">Need help? Contact Greenpay through the app.</p>${footerLinks ? `<p style="margin:0 0 8px">${footerLinks}</p>` : ""}<p style="margin:0">Greenpay · Payments with clarity</p></footer></section></main></body></html>`;
  return { subject, text, html };
}

export function renderTransactionalEmail(
  template: TransactionalTemplate | string,
  payload: TransactionalEmailPayload,
): TransactionalEmailContent {
  if (template === "payment_receipt") {
    const amount = value(payload, "amount");
    const currency = value(payload, "currency");
    const reference = value(payload, "reference");
    const name = value(payload, "customerName", "there");
    const paragraphs = [
      `Hello ${name},`,
      `Your payment of ${amount} ${currency} has been confirmed by Greenpay.`,
      `Payment reference: ${reference}.`,
      "This receipt shows the original payment amount and currency exactly as confirmed.",
    ];
    const receiptUrl = approvedDeploymentUrl(value(payload, "receiptUrl"));
    return branded("Your Greenpay payment receipt", paragraphs,
      receiptUrl ? { label: "View payment status", href: receiptUrl } : undefined);
  }
  if (template === "payment_success" || template === "payment_failure") {
    const successful = template === "payment_success";
    const reference = value(payload, "reference");
    return branded(successful ? "Payment confirmed" : "Payment failed", [
      value(payload, "businessName", "Your business"),
      `Payment ${reference} is ${successful ? "confirmed" : "failed"}.`,
      `Amount: ${value(payload, "amount")} ${value(payload, "currency")}.`,
    ]);
  }
  if (template === "payout_update") {
    return branded("Payout status updated", [
      value(payload, "businessName", "Your business"),
      `Payout ${value(payload, "reference")} is ${value(payload, "status")}.`,
      `Amount: ${value(payload, "amount")} ${value(payload, "currency")}.`,
    ]);
  }
  if (template === "invoice_reminder") {
    const paymentUrl = value(payload, "paymentUrl");
    const approvedPaymentUrl = approvedDeploymentUrl(paymentUrl);
    const link = approvedPaymentUrl ? { label: "Pay invoice", href: approvedPaymentUrl } : undefined;
    const dueDate = value(payload, "dueDate");
    return branded("Invoice payment reminder", [
      `Hello ${value(payload, "customerName", "there")},`,
      `${value(payload, "businessName", "Your business")} has an outstanding invoice ${value(payload, "invoiceReference")}.`,
      `Remaining balance: ${value(payload, "amount")} ${value(payload, "currency")}.`,
      dueDate ? `Due date: ${dueDate}.` : "Please contact the business if you need help with this invoice.",
    ], link);
  }
  if (template === "payment_link_reminder") {
    const paymentUrl = approvedDeploymentUrl(value(payload, "paymentUrl"));
    return branded("Payment link reminder", [
      `Hello ${value(payload, "customerName", "there")},`,
      `${value(payload, "businessName", "Your business")} has shared a payment link with you.`,
      value(payload, "description", "Please complete your payment using the secure link below."),
      `Amount: ${value(payload, "amount", "As selected by you")} ${value(payload, "currency")}.`,
    ], paymentUrl ? { label: "Complete payment", href: paymentUrl } : undefined);
  }
  if (template === "payment_failure_recovery") {
    const paymentUrl = approvedDeploymentUrl(value(payload, "paymentUrl"));
    return branded("Try your payment again", [
      `Hello ${value(payload, "customerName", "there")},`,
      `Your payment ${value(payload, "reference")} could not be completed.`,
      "You can try again using the secure payment link below. Do not make another payment if your bank already confirmed the first one; contact the business if you are unsure.",
    ], paymentUrl ? { label: "Try payment again", href: paymentUrl } : undefined);
  }
  if (template === "support_reply" || template === "support_receipt") {
    const receipt = template === "support_receipt";
    return branded(receipt ? "We received your support request" : "A reply from Greenpay Support", [
      `Support ticket ${value(payload, "ticketReference")}: ${value(payload, "subject")}`,
      value(payload, "body", receipt ? "Our support team will review your request." : "A new message is available in your support conversation."),
    ]);
  }
  if (template === "team_invitation") {
    const inviteUrl = approvedDeploymentUrl(value(payload, "inviteUrl"));
    return branded("You are invited to a Greenpay team", [
      `${value(payload, "inviterName", "A Greenpay administrator")} invited you to join ${value(payload, "businessName", "a Greenpay business")} as ${value(payload, "role", "a team member")}.`,
      `This invitation expires ${value(payload, "expiresAt", "as shown in your invitation link")}.`,
    ], inviteUrl ? { label: "Accept invitation", href: inviteUrl } : undefined);
  }
  if (template === "admin_test") {
    return branded("Greenpay email delivery test", [
      "This message confirms that a user-triggered Greenpay Mailtrap test send was accepted.",
      `Requested at ${value(payload, "requestedAt")}.`,
    ]);
  }
  if (template === "admin_broadcast") {
    const message = value(payload, "message").replace(/\r\n?/g, "\n").trim();
    const paragraphs = message.split(/\n\s*\n/).map((part) => part.replace(/\n/g, " ").trim()).filter(Boolean);
    return branded(value(payload, "subject", "A message from Greenpay"), paragraphs.length ? paragraphs : [message]);
  }
  throw new Error(`Unsupported transactional email template: ${template}`);
}