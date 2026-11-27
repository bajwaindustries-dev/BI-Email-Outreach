
const ALARM_NAME = "bi-next-email";
const CAMPAIGN_KEY = "biCampaign";
const GAP_MS = 240000; // 4 minutes

async function getCampaign() {
  const data = await chrome.storage.local.get(CAMPAIGN_KEY);
  return data[CAMPAIGN_KEY] || null;
}

async function saveCampaign(campaign) {
  await chrome.storage.local.set({ [CAMPAIGN_KEY]: campaign });
}

function base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendEmail(recipient, subject, message) {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(
          chrome.runtime.lastError?.message || "Gmail authorization failed."
        ));
        return;
      }
      resolve(token);
    });
  });

  const safeSubject = subject.replace(/[\r\n]/g, " ");
  const personalized = message.replace(
    /\{name\}/gi,
    recipient.name || "there"
  );

  const mime = [
    `To: ${recipient.email}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(safeSubject)))}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa(unescape(encodeURIComponent(personalized)))
  ].join("\r\n");

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ raw: base64Url(mime) })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "Gmail sending failed.");
  }

  return result.id;
}

async function scheduleNext(timestamp) {
  await chrome.alarms.clear(ALARM_NAME);

  const remaining = Math.max(0.5, (timestamp - Date.now()) / 60000);

  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: remaining
  });
}

async function processNext() {
  let campaign = await getCampaign();

  if (!campaign || campaign.status !== "running") return;

  if (campaign.inFlight) {
    campaign.status = "review";
    campaign.lastError =
      "Previous send needs review. Check Gmail Sent before continuing.";
    await saveCampaign(campaign);
    return;
  }

  while (campaign.nextIndex < campaign.recipients.length) {
    const recipient = campaign.recipients[campaign.nextIndex];
    const email = recipient.email.toLowerCase();

    if (campaign.sentEmails.includes(email)) {
      campaign.nextIndex++;
      await saveCampaign(campaign);
      continue;
    }

    if (campaign.suppressedEmails.includes(email)) {
      campaign.nextIndex++;
      await saveCampaign(campaign);
      continue;
    }

    campaign.inFlight = {
      email,
      index: campaign.nextIndex,
      startedAt: Date.now()
    };

    await saveCampaign(campaign);

    try {
      const messageId = await sendEmail(
        recipient,
        campaign.subject,
        campaign.message
      );

      campaign.sentEmails.push(email);
      campaign.lastMessageId = messageId;
      campaign.lastSentAt = Date.now();
      campaign.inFlight = null;
      campaign.nextIndex++;

      if (campaign.nextIndex >= campaign.recipients.length) {
        campaign.status = "completed";
        await saveCampaign(campaign);
        await chrome.alarms.clear(ALARM_NAME);
        return;
      }

      campaign.nextSendAt = Date.now() + GAP_MS;
      await saveCampaign(campaign);
      await scheduleNext(campaign.nextSendAt);
      return;

    } catch (error) {
      campaign.status = "review";
      campaign.lastError = error.message;
      await saveCampaign(campaign);
      return;
    }
  }

  campaign.status = "completed";
  await saveCampaign(campaign);
  await chrome.alarms.clear(ALARM_NAME);
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    processNext();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const campaign = await getCampaign();

  if (!campaign || campaign.status !== "running") return;

  if (campaign.inFlight) {
    campaign.status = "review";
    campaign.lastError =
      "A send was interrupted. Check Gmail Sent before resuming.";
    await saveCampaign(campaign);
    return;
  }

  await scheduleNext(campaign.nextSendAt || Date.now() + GAP_MS);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action === "START_CAMPAIGN") {
      const existing = await getCampaign();

      if (existing && ["running", "paused", "review"].includes(existing.status)) {
        throw new Error("An existing campaign needs to be resumed or reviewed.");
      }

      const recipients = message.recipients || [];
      const subject = String(message.subject || "").trim();
      const body = String(message.message || "").trim();

      if (!message.permission || !recipients.length || !subject || !body) {
        throw new Error("Permission, recipients, subject and message are required.");
      }

      const emails = recipients.map(r => String(r.email || "").toLowerCase());

      if (new Set(emails).size !== emails.length) {
        throw new Error("Duplicate recipients detected. Campaign not started.");
      }

      const campaign = {
        status: "running",
        recipients,
        subject,
        message: body,
        nextIndex: 0,
        sentEmails: [],
        suppressedEmails: [],
        inFlight: null,
        nextSendAt: Date.now()
      };

      await saveCampaign(campaign);
      await processNext();

      return { success: true };
    }

    if (message.action === "PAUSE_CAMPAIGN") {
      const campaign = await getCampaign();
      if (campaign) {
        campaign.status = "paused";
        await saveCampaign(campaign);
      }
      await chrome.alarms.clear(ALARM_NAME);
      return { success: true };
    }

    if (message.action === "RESUME_CAMPAIGN") {
      const campaign = await getCampaign();

      if (!campaign) throw new Error("No saved campaign found.");
      if (campaign.inFlight) {
        throw new Error("Check Gmail Sent first. An earlier send needs review.");
      }

      campaign.status = "running";
      await saveCampaign(campaign);
      await scheduleNext(campaign.nextSendAt || Date.now() + GAP_MS);

      return { success: true };
    }

    if (message.action === "STOP_CAMPAIGN") {
      const campaign = await getCampaign();

      if (campaign) {
        campaign.status = "stopped";
        await saveCampaign(campaign);
      }

      await chrome.alarms.clear(ALARM_NAME);
      return { success: true };
    }

    if (message.action === "GET_CAMPAIGN") {
      return { campaign: await getCampaign() };
    }

    throw new Error("Unknown campaign action.");
  })()
    .then(sendResponse)
    .catch(error => sendResponse({
      success: false,
      error: error.message
    }));

  return true;
});
