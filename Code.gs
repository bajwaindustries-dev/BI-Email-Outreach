
function doGet() {
  return HtmlService.createHtmlOutput(
    "BI Email Outreach Backend is running."
  );
}

function testConnection() {
  const email = Session.getActiveUser().getEmail();

  return {
    success: true,
    account: email || "Google account connected"
  };
}

function sendBatch(data) {
  if (!data || data.permission !== true) {
    throw new Error("Recipient permission confirmation required.");
  }

  if (!Array.isArray(data.recipients) ||
      data.recipients.length < 1 ||
      data.recipients.length > 10) {
    throw new Error("Batch must contain 1 to 10 recipients.");
  }

  const subject = String(data.subject || "").trim();
  const message = String(data.message || "").trim();

  if (!subject || !message) {
    throw new Error("Subject and message are required.");
  }

  const results = [];

  for (const recipient of data.recipients) {
    const email = String(recipient.email || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.push({ email, status: "failed", reason: "Invalid email" });
      continue;
    }

    try {
      GmailApp.sendEmail(email, subject, message);
      results.push({ email, status: "sent" });
    } catch (error) {
      results.push({
        email,
        status: "failed",
        reason: String(error.message)
      });
    }
  }

  return results;
}
