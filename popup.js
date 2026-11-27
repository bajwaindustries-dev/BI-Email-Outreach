
document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  const csvInput = $("csvFile");
  const photoInput = $("photos");
  const saveBtn = $("saveBtn");
  const testBtn = $("testSendBtn");
  const startBtn = $("startCampaignBtn");
  const pauseBtn = $("pauseCampaignBtn");
  const stopBtn = $("stopCampaignBtn");
  const status = $("status");
  const campaignStatus = $("campaignStatus");
  const progress = $("campaignProgress");
  const summary = $("csvSummary");

  let recipients = [];
  let campaignIndex = 0;
  let campaignRunning = false;
  let campaignPaused = false;
  let campaignStopped = false;

  const MAX_PER_SESSION = 10;
  const DELAY_MS = 60000;

  function showStatus(message) {
    status.textContent = message;
  }

  function showCampaign(message) {
    campaignStatus.textContent = message;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '"' && quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        row.push(cell.trim());
        if (row.some(value => value !== "")) rows.push(row);
        row = [];
        cell = "";
        if (char === "\r" && text[i + 1] === "\n") i++;
      } else {
        cell += char;
      }
    }

    row.push(cell.trim());
    if (row.some(value => value !== "")) rows.push(row);

    return rows;
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function updateProgress() {
    const total = recipients.length;
    progress.max = total || 1;
    progress.value = campaignIndex;
  }

  function updateCampaignButtons() {
    startBtn.disabled =
      campaignRunning ||
      campaignIndex >= recipients.length ||
      recipients.length === 0;

    pauseBtn.disabled = !campaignRunning;
    stopBtn.disabled = !campaignRunning;

    startBtn.textContent =
      campaignIndex > 0 ? "Continue Campaign" : "Start Campaign";
  }

  csvInput.addEventListener("change", async () => {
    const file = csvInput.files[0];
    if (!file) return;

    try {
      const rows = parseCSV(await file.text());

      if (rows.length < 2) {
        showStatus("CSV file is empty or invalid.");
        return;
      }

      const headers = rows[0].map(h =>
        h.replace(/^\uFEFF/, "").trim().toLowerCase()
      );

      if (!headers.includes("name") || !headers.includes("email")) {
        showStatus("CSV headings must include Name and Email.");
        return;
      }

      const nameIndex = headers.indexOf("name");
      const emailIndex = headers.indexOf("email");

      const seen = new Set();
      const validRecipients = [];
      let invalid = 0;
      let duplicates = 0;

      rows.slice(1).forEach(row => {
        const email = (row[emailIndex] || "").trim().toLowerCase();
        const name = (row[nameIndex] || "").trim();

        if (!validEmail(email)) {
          invalid++;
          return;
        }

        if (seen.has(email)) {
          duplicates++;
          return;
        }

        seen.add(email);
        validRecipients.push({ name, email });
      });

      recipients = validRecipients;
      campaignIndex = 0;
      campaignStopped = false;
      campaignPaused = false;

      summary.textContent =
        `${recipients.length} valid unique recipients | ` +
        `${invalid} invalid rows | ${duplicates} duplicates.`;

      updateProgress();
      updateCampaignButtons();

      showCampaign("CSV ready. Review the recipient count before starting.");
      showStatus("CSV checked. No campaign emails sent.");
    } catch (error) {
      showStatus("CSV error: " + error.message);
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (photoInput.files.length > 3) {
      showStatus("Maximum 3 photos allowed.");
      return;
    }

    const settings = {
      subject: $("subject").value,
      message: $("message").value,
      savedAt: new Date().toISOString()
    };

    try {
      await chrome.storage.local.set({ biDraftSettings: settings });
      showStatus("Draft settings saved successfully.");
    } catch (error) {
      showStatus("Save error: " + error.message);
    }
  });

  testBtn.addEventListener("click", async () => {
    const email = $("testEmail").value.trim();
    const subject = $("subject").value.trim();
    const message = $("message").value.trim();
    const photos = Array.from(photoInput.files);
    const permission = $("permissionCheck").checked;

    if (!validEmail(email)) {
      showStatus("Please enter a valid test recipient email.");
      return;
    }

    if (!subject || !message) {
      showStatus("Please enter both subject and message.");
      return;
    }

    if (!permission) {
      showStatus("Please confirm you have permission to contact this recipient.");
      return;
    }

    if (photos.length > 3) {
      showStatus("Maximum 3 photos allowed.");
      return;
    }

    if (!confirm(`Send ONE test email to ${email}?`)) return;

    testBtn.disabled = true;
    showStatus("Connecting to Gmail...");

    try {
      const result = await BIEmail.sendOneTest({
        email,
        subject,
        message,
        photos
      });

      showStatus(
        `Test email accepted by Gmail for ${result.recipient}. ` +
        `Message ID: ${result.messageId}`
      );
    } catch (error) {
      showStatus("Sending error: " + (error.message || "Unknown error"));
    } finally {
      testBtn.disabled = false;
    }
  });

  startBtn.addEventListener("click", async () => {
    const subject = $("subject").value.trim();
    const message = $("message").value.trim();
    const photos = Array.from(photoInput.files);

    if (!recipients.length) {
      showStatus("Please upload a valid buyer CSV first.");
      return;
    }

    if (!$("permissionCheck").checked) {
      showStatus("Please confirm your authorization to contact these recipients.");
      return;
    }

    if (!subject || !message) {
      showStatus("Subject and message are required.");
      return;
    }

    if (!/(unsubscribe|opt.?out|reply\s+stop)/i.test(message)) {
      showStatus(
        'Add a clear opt-out instruction, such as "Reply STOP to opt out", to your message.'
      );
      return;
    }

    if (photos.length > 3) {
      showStatus("Maximum 3 photos allowed.");
      return;
    }

    const remaining = recipients.length - campaignIndex;
    const sessionCount = Math.min(MAX_PER_SESSION, remaining);

    if (!confirm(
      `Start a controlled campaign for ${sessionCount} recipients? ` +
      `There will be a 60-second gap between emails.`
    )) return;

    campaignRunning = true;
    campaignPaused = false;
    campaignStopped = false;
    updateCampaignButtons();

    let sent = 0;
    let failed = 0;

    showCampaign("Campaign running...");

    try {
      while (
        campaignIndex < recipients.length &&
        sent + failed < MAX_PER_SESSION &&
        !campaignStopped
      ) {
        while (campaignPaused && !campaignStopped) {
          await sleep(500);
        }

        if (campaignStopped) break;

        const recipient = recipients[campaignIndex];
        const personalizedMessage = message.replace(
          /\{name\}/gi,
          recipient.name || "there"
        );

        showCampaign(
          `Sending ${campaignIndex + 1} of ${recipients.length}: ${recipient.email}`
        );

        try {
          await BIEmail.sendOneCampaignEmail({
            email: recipient.email,
            subject,
            message: personalizedMessage,
            photos
          });
          sent++;
        } catch (error) {
          failed++;
          showStatus(
            `Failed: ${recipient.email} — ${error.message || "Unknown error"}`
          );
        }

        campaignIndex++;
        updateProgress();

        if (
          campaignIndex < recipients.length &&
          sent + failed < MAX_PER_SESSION &&
          !campaignStopped
        ) {
          let waited = 0;

          while (waited < DELAY_MS && !campaignStopped) {
            while (campaignPaused && !campaignStopped) {
              await sleep(500);
            }

            if (campaignStopped) break;

            await sleep(1000);
            waited += 1000;
          }
        }
      }
    } finally {
      campaignRunning = false;
      campaignPaused = false;
      updateCampaignButtons();

      if (campaignStopped) {
        showCampaign(`Stopped. ${sent} sent, ${failed} failed in this session.`);
      } else if (campaignIndex >= recipients.length) {
        showCampaign(`Finished. ${sent} sent, ${failed} failed in this session.`);
      } else {
        showCampaign(
          `Session ended. ${sent} sent, ${failed} failed. ` +
          `${recipients.length - campaignIndex} recipients remain.`
        );
      }
    }
  });

  pauseBtn.addEventListener("click", () => {
    campaignPaused = !campaignPaused;
    pauseBtn.textContent = campaignPaused ? "Resume" : "Pause";
    showCampaign(campaignPaused ? "Campaign paused." : "Campaign resumed.");
  });

  stopBtn.addEventListener("click", () => {
    campaignStopped = true;
    campaignPaused = false;
    showCampaign("Stopping after the current operation...");
  });

  chrome.storage.local.get("biDraftSettings", result => {
    const saved = result.biDraftSettings;
    if (saved) {
      $("subject").value = saved.subject || "";
      $("message").value = saved.message || "";
    }
  });

  updateCampaignButtons();
});
