
const ALARM_NAME = "bi-next-email";
const CAMPAIGN_KEY = "biCampaign";
const SENT_HISTORY_KEY = "biSentEmails";

const GAP_MS = 240000; // 4 minutes
const MAX_PHOTOS = 3;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

let isProcessing = false;

// ---------------- STORAGE ----------------

async function getCampaign() {
  const data = await chrome.storage.local.get(CAMPAIGN_KEY);
  return data[CAMPAIGN_KEY] || null;
}

async function saveCampaign(campaign) {
  await chrome.storage.local.set({
    [CAMPAIGN_KEY]: campaign
  });
}

async function getSentHistory() {
  const data = await chrome.storage.local.get(SENT_HISTORY_KEY);
  return data[SENT_HISTORY_KEY] || [];
}

async function addToSentHistory(email) {
  const history = await getSentHistory();

  if (!history.includes(email)) {
    history.push(email);
    await chrome.storage.local.set({
      [SENT_HISTORY_KEY]: history
    });
  }
}

// ---------------- ENCODING ----------------

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

function base64Url(text) {
  return bytesToBase64(
    new TextEncoder().encode(text)
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeText(text) {
  return bytesToBase64(
    new TextEncoder().encode(text)
  ).replace(/.{1,76}/g, "$&\r\n").trim();
}

// ---------------- GMAIL AUTH ----------------

async function getAccessToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(
      { interactive: false },
      result => {
        if (chrome.runtime.lastError || !result) {
          reject(new Error(
            chrome.runtime.lastError?.message ||
            "Gmail authorization failed."
          ));
          return;
        }

        const token =
          typeof result === "string" ? result : result.token;

        if (!token) {
          reject(new Error("Gmail access token not found."));
          return;
        }

        resolve(token);
      }
    );
  });
}

// ---------------- ATTACHMENTS ----------------

function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    throw new Error("Invalid photo attachment list.");
  }

  if (attachments.length > MAX_PHOTOS) {
    throw new Error("Maximum 3 product photos are allowed.");
  }

  let totalBytes = 0;

  for (const file of attachments) {
    if (
      !file ||
      typeof file.dataUrl !== "string" ||
      typeof file.name !== "string"
    ) {
      throw new Error("Invalid photo attachment.");
    }

    const match = file.dataUrl.match(
      /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/
    );

    if (!match) {
      throw new Error(
        "Only JPEG, PNG, GIF and WebP photos are supported."
      );
    }

    const base64 = match[2];

    if (base64.length % 4 !== 0) {
      throw new Error("Invalid photo data.");
    }

    totalBytes += Math.floor(base64.length * 3 / 4);
  }

  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error("Total photo size must not exceed 3 MB.");
  }

  return attachments;
}

// ---------------- EMAIL SENDING ----------------

async function sendEmail(recipient, subject, message, attachments = []) {
  const token = await getAccessToken();

  const safeEmail = recipient.email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    throw new Error("Invalid recipient email address.");
  }

  const safeSubject = subject.replace(/[\r\n]/g, " ");

  const personalized = message.replace(
    /\{name\}/gi,
    recipient.name || "there"
  );

  const encodedSubject = bytesToBase64(
    new TextEncoder().encode(safeSubject)
  );

  const headers = [
    `To: ${safeEmail}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "MIME-Version: 1.0"
  ];

  let mime;

  if (!attachments.length) {
    mime = [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodeText(personalized)
    ].join("\r\n");
  } else {
    const boundary = "BI_BOUNDARY_" +
      Date.now() + "_" +
      Math.random().toString(36).slice(2);

    const parts = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodeText(personalized)
    ];

    for (const file of attachments) {
      const match = file.dataUrl.match(
        /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/
      );

      const mimeType = match[1];
      const base64 = match[2];

      const filename = file.name
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 100) || "product-photo";

      parts.push(
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${filename}"`,
        "",
        base64.replace(/.{1,76}/g, "$&\r\n").trim()
      );
    }

    parts.push(`--${boundary}--`);

    mime = parts.join("\r\n");
  }

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        raw: base64Url(mime)
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error?.message || "Gmail sending failed."
    );
  }

  return result.id;
}

// ---------------- SCHEDULING ----------------

async function scheduleNext(timestamp) {
  await chrome.alarms.clear(ALARM_NAME);

  const delay = Math.max(
    0.5,
    (timestamp - Date.now()) / 60000
  );

  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: delay
  });
}

// ---------------- CAMPAIGN PROCESSOR ----------------

async function processNext() {
  if (isProcessing) return;

  isProcessing = true;

  try {
    let campaign = await getCampaign();

    if (!campaign || campaign.status !== "running") {
      return;
    }

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

      const history = await getSentHistory();

      if (
        campaign.sentEmails.includes(email) ||
        history.includes(email) ||
        campaign.suppressedEmails.includes(email)
      ) {
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
          campaign.message,
          campaign.attachments || []
        );

        const latest = await getCampaign();

        if (!latest) return;

        if (!latest.sentEmails.includes(email)) {
          latest.sentEmails.push(email);
        }

        await addToSentHistory(email);

        latest.lastMessageId = messageId;
        latest.lastSentAt = Date.now();
        latest.inFlight = null;

        latest.nextIndex = Math.max(
          latest.nextIndex,
          campaign.nextIndex + 1
        );

        if (latest.nextIndex >= latest.recipients.length) {
          latest.status = "completed";
          await saveCampaign(latest);
          await chrome.alarms.clear(ALARM_NAME);
          return;
        }

        latest.nextSendAt = Date.now() + GAP_MS;

        await saveCampaign(latest);

        if (latest.status === "running") {
          await scheduleNext(latest.nextSendAt);
        } else {
          await chrome.alarms.clear(ALARM_NAME);
        }

        return;

      } catch (error) {
        const latest = await getCampaign();

        if (latest) {
          latest.status = "review";
          latest.lastError = error.message;
          await saveCampaign(latest);
        }

        await chrome.alarms.clear(ALARM_NAME);
        return;
      }
    }

    campaign.status = "completed";
    campaign.inFlight = null;

    await saveCampaign(campaign);
    await chrome.alarms.clear(ALARM_NAME);

  } finally {
    isProcessing = false;
  }
}

// ---------------- ALARM ----------------

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    processNext();
  }
});

// ---------------- BROWSER RESTART ----------------

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

  await scheduleNext(
    campaign.nextSendAt || Date.now() + GAP_MS
  );
});

// ---------------- MESSAGE HANDLER ----------------

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    (async () => {

      if (message.action === "GET_CAMPAIGN") {
        return {
          success: true,
          campaign: await getCampaign()
        };
      }

      // START CAMPAIGN

      if (message.action === "START_CAMPAIGN") {
        const existing = await getCampaign();

        if (
          existing &&
          ["running", "paused", "review"].includes(existing.status)
        ) {
          throw new Error(
            "Existing campaign needs to be resumed or reviewed."
          );
        }

        const recipients = (message.recipients || [])
          .map(item => {
            if (typeof item === "string") {
              return {
                name: "",
                email: item.trim().toLowerCase()
              };
            }

            return {
              name: String(item.name || "").trim(),
              email: String(item.email || "").trim().toLowerCase()
            };
          })
          .filter(item => item.email);

        const subject = String(message.subject || "").trim();
        const body = String(message.message || "").trim();

        const suppressedEmails = [
          ...new Set(
            (message.suppressedEmails || [])
              .map(email => String(email).trim().toLowerCase())
              .filter(Boolean)
          )
        ];

        const attachments = validateAttachments(
          message.attachments || []
        );

        if (
          message.permission !== true ||
          !recipients.length ||
          !subject ||
          !body
        ) {
          throw new Error(
            "Permission, recipients, subject and message are required."
          );
        }

        const emails = recipients.map(item => item.email);

        if (new Set(emails).size !== emails.length) {
          throw new Error(
            "Duplicate recipients detected. Campaign not started."
          );
        }

        const invalid = emails.find(
          email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        );

        if (invalid) {
          throw new Error("Invalid recipient email: " + invalid);
        }

        const campaign = {
          status: "running",
          recipients,
          subject,
          message: body,
          attachments,
          nextIndex: 0,
          sentEmails: [],
          suppressedEmails,
          inFlight: null,
          nextSendAt: Date.now()
        };

        await saveCampaign(campaign);
        await processNext();

        return {
          success: true,
          campaign: await getCampaign()
        };
      }

      // UPDATE UNSUBSCRIBE LIST

      if (message.action === "UPDATE_SUPPRESSION") {
        const campaign = await getCampaign();

        if (!campaign) {
          throw new Error("No saved campaign found.");
        }

        const additions = (message.emails || [])
          .map(email => String(email).trim().toLowerCase())
          .filter(email =>
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          );

        campaign.suppressedEmails = [
          ...new Set([
            ...(campaign.suppressedEmails || []),
            ...additions
          ])
        ];

        await saveCampaign(campaign);

        return {
          success: true,
          suppressedCount: campaign.suppressedEmails.length
        };
      }

      // PAUSE

      if (message.action === "PAUSE_CAMPAIGN") {
        const campaign = await getCampaign();

        if (!campaign || campaign.status !== "running") {
          throw new Error("No running campaign to pause.");
        }

        campaign.status = "paused";
        await saveCampaign(campaign);

        await chrome.alarms.clear(ALARM_NAME);

        return { success: true };
      }

      // RESUME

      if (message.action === "RESUME_CAMPAIGN") {
        const campaign = await getCampaign();

        if (!campaign) {
          throw new Error("No saved campaign found.");
        }

        if (campaign.status !== "paused") {
          throw new Error("Only a paused campaign can be resumed.");
        }

        if (campaign.inFlight) {
          throw new Error(
            "Check Gmail Sent first. An earlier send needs review."
          );
        }

        campaign.status = "running";
        await saveCampaign(campaign);

        await scheduleNext(
          campaign.nextSendAt || Date.now() + GAP_MS
        );

        return { success: true };
      }

      // STOP

      if (message.action === "STOP_CAMPAIGN") {
        const campaign = await getCampaign();

        if (!campaign) {
          throw new Error("No saved campaign found.");
        }

        campaign.status = "stopped";
        await saveCampaign(campaign);

        await chrome.alarms.clear(ALARM_NAME);

        return { success: true };
      }

      throw new Error("Unsupported action: " + message.action);

    })()
      .then(sendResponse)
      .catch(error => {
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true;
  }
);
