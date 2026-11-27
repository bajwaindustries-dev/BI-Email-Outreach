
const ALARM_NAME = "bi-next-email";
const STORAGE_KEY = "biCampaign";
const DELAY_MS = 4 * 60 * 1000;

let isProcessing = false;

async function getCampaign() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || null;
}

async function saveCampaign(campaign) {
  await chrome.storage.local.set({ [STORAGE_KEY]: campaign });
}

function scheduleNext(timestamp) {
  chrome.alarms.create(ALARM_NAME, { when: timestamp });
}

function encodeBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendEmail(campaign, recipient) {
  // Popup must authorize Gmail first. Background uses cached authorization.
  const tokenResult = await chrome.identity.getAuthToken({
    interactive: false
  });

  const token = typeof tokenResult === "string"
    ? tokenResult
    : tokenResult.token;

  if (!token) {
    throw new Error("Gmail authorization unavailable. Please authorize Gmail again.");
  }

  const subject = `=?UTF-8?B?${btoa(
    unescape(encodeURIComponent(campaign.subject))
  )}?=`;

  const mime = [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(unescape(encodeURIComponent(campaign.message)))
  ].join("\r\n");

  const raw = encodeBase64Url(mime);

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ raw })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail API error ${response.status}: ${errorText}`);
  }

  return await response.json();
}

async function processNext() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    let campaign = await getCampaign();

    if (!campaign || campaign.status !== "running") return;

    const sent = new Set(
      (campaign.sentEmails || []).map(email => email.toLowerCase())
    );

    // Find the next recipient not already sent or suppressed.
    while (campaign.nextIndex < campaign.recipients.length) {
      const email = campaign.recipients[campaign.nextIndex].trim().toLowerCase();

      if (
        sent.has(email) ||
        (campaign.suppressedEmails || []).includes(email)
      ) {
        campaign.nextIndex++;
        await saveCampaign(campaign);
      } else {
        break;
      }
    }

    if (campaign.nextIndex >= campaign.recipients.length) {
      campaign.status = "completed";
      campaign.nextSendAt = null;
      await saveCampaign(campaign);
      return;
    }

    const recipient = campaign.recipients[campaign.nextIndex]
      .trim()
      .toLowerCase();

    // Save the in-flight recipient before attempting to send.
    campaign.inFlight = recipient;
    await saveCampaign(campaign);

    try {
      await sendEmail(campaign, recipient);
    } catch (error) {
      // Do not retry automatically: the send outcome may be uncertain.
      const latest = await getCampaign();
      latest.status = "review";
      latest.lastError = error.message;
      latest.inFlight = recipient;
      latest.nextSendAt = null;
      await saveCampaign(latest);
      return;
    }

    // Re-read state so a Pause or Stop during sending is not overwritten.
    const latest = await getCampaign();

    latest.sentEmails = latest.sentEmails || [];

    if (!latest.sentEmails.some(
      email => email.toLowerCase() === recipient
    )) {
      latest.sentEmails.push(recipient);
    }

    latest.nextIndex = Math.max(
      latest.nextIndex || 0,
      campaign.nextIndex + 1
    );

    latest.inFlight = null;
    latest.lastError = null;

    if (latest.nextIndex >= latest.recipients.length) {
      latest.status = "completed";
      latest.nextSendAt = null;
      await saveCampaign(latest);
      return;
    }

    if (latest.status === "running") {
      latest.nextSendAt = Date.now() + DELAY_MS;
      await saveCampaign(latest);
      scheduleNext(latest.nextSendAt);
    } else {
      // Keep paused/stopped status if the user changed it during sending.
      latest.nextSendAt = null;
      await saveCampaign(latest);
    }

  } finally {
    isProcessing = false;
  }
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    await processNext();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const campaign = await getCampaign();

  if (!campaign || campaign.status !== "running") return;

  // An interrupted send needs manual checking to prevent duplicates.
  if (campaign.inFlight) {
    campaign.status = "review";
    campaign.lastError =
      "Browser restarted during a send. Check Gmail Sent before continuing.";
    campaign.nextSendAt = null;
    await saveCampaign(campaign);
    return;
  }

  scheduleNext(
    Math.max(Date.now() + 1000, campaign.nextSendAt || Date.now())
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    let campaign = await getCampaign();

    switch (message.action) {
      case "GET_CAMPAIGN":
        return campaign;

      case "START_CAMPAIGN": {
        // Never overwrite an existing campaign or its sent history.
        if (campaign) {
          throw new Error(
            "An existing campaign record is present. It cannot be replaced automatically."
          );
        }

        const recipients = (message.recipients || [])
          .map(email => email.trim().toLowerCase())
          .filter(Boolean);

        if (!recipients.length) {
          throw new Error("No valid recipients found.");
        }

        if (!message.subject || !message.message) {
          throw new Error("Subject and message are required.");
        }

        campaign = {
          status: "running",
          recipients: [...new Set(recipients)],
          subject: message.subject,
          message: message.message,
          sentEmails: [],
          suppressedEmails: (message.suppressedEmails || [])
            .map(email => email.toLowerCase()),
          nextIndex: 0,
          inFlight: null,
          nextSendAt: null,
          lastError: null,
          createdAt: Date.now()
        };

        await saveCampaign(campaign);
        await processNext();
        return await getCampaign();
      }

      case "PAUSE_CAMPAIGN":
        if (campaign && campaign.status === "running") {
          campaign.status = "paused";
          campaign.nextSendAt = null;
          await saveCampaign(campaign);
          await chrome.alarms.clear(ALARM_NAME);
        }
        return campaign;

      case "RESUME_CAMPAIGN":
        if (!campaign || campaign.status !== "paused") {
          throw new Error("Only a paused campaign can be resumed.");
        }

        if (campaign.inFlight) {
          throw new Error(
            "A previous send needs checking in Gmail Sent before resuming."
          );
        }

        campaign.status = "running";
        campaign.nextSendAt = Date.now() + 1000;
        await saveCampaign(campaign);
        scheduleNext(campaign.nextSendAt);
        return campaign;

      case "STOP_CAMPAIGN":
        if (campaign) {
          campaign.status = "stopped";
          campaign.nextSendAt = null;
          await saveCampaign(campaign);
          await chrome.alarms.clear(ALARM_NAME);
        }
        return campaign;

      default:
        throw new Error("Unknown action.");
    }
  })()
    .then(result => sendResponse({ success: true, campaign: result }))
    .catch(error => sendResponse({
      success: false,
      error: error.message
    }));

  return true;
});
