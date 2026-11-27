
document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  let recipients = [];
  let currentCampaign = null;

  const csvInput = $("csvFile");
  const startBtn = $("startCampaignBtn");
  const pauseBtn = $("pauseCampaignBtn");
  const stopBtn = $("stopCampaignBtn");

  function status(message) {
    $("status").textContent = message;
  }

  function campaignStatus(message) {
    $("campaignStatus").textContent = message;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (c === '"' && quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = !quoted;
      } else if (c === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((c === "\n" || c === "\r") && !quoted) {
        row.push(cell.trim());
        if (row.some(v => v)) rows.push(row);
        row = [];
        cell = "";
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else {
        cell += c;
      }
    }

    row.push(cell.trim());
    if (row.some(v => v)) rows.push(row);
    return rows;
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function updateUI(campaign) {
    currentCampaign = campaign;

    if (!campaign) {
      campaignStatus("No saved campaign.");
      $("campaignProgress").value = 0;
      $("campaignProgress").max = 1;
      startBtn.textContent = "Start Campaign";
      startBtn.disabled = recipients.length === 0;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      return;
    }

    const total = campaign.recipients?.length || 0;
    const sent = campaign.sentEmails?.length || 0;
    const next = campaign.nextIndex || 0;

    $("campaignProgress").max = total || 1;
    $("campaignProgress").value = Math.min(next, total);

    campaignStatus(
      `Status: ${campaign.status} | Sent: ${sent} | ` +
      `Remaining: ${Math.max(0, total - next)}`
    );

    if (campaign.lastError) {
      status("Campaign needs review: " + campaign.lastError);
    }

    startBtn.textContent =
      campaign.status === "paused"
        ? "Continue Campaign"
        : "Start Campaign";

    startBtn.disabled = !["paused"].includes(campaign.status);

    pauseBtn.disabled = campaign.status !== "running";
    stopBtn.disabled = !["running", "paused"].includes(campaign.status);
  }

  function sendAction(action, extra = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action, ...extra },
        response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response?.success) {
            reject(new Error(response?.error || "Unknown extension error."));
            return;
          }

          resolve(response);
        }
      );
    });
  }

  async function refreshCampaign() {
    try {
      const result = await sendAction("GET_CAMPAIGN");
      updateUI(result.campaign);
    } catch (error) {
      status("Campaign status error: " + error.message);
    }
  }

  csvInput.addEventListener("change", async () => {
    const file = csvInput.files[0];
    if (!file) return;

    try {
      const rows = parseCSV(await file.text());

      if (rows.length < 2) {
        status("CSV file is empty or invalid.");
        return;
      }

      const headers = rows[0].map(h =>
        h.replace(/^\uFEFF/, "").trim().toLowerCase()
      );

      const nameIndex = headers.indexOf("name");
      const emailIndex = headers.indexOf("email");

      if (emailIndex === -1 || nameIndex === -1) {
        status("CSV must contain Name and Email headings.");
        return;
      }

      const seen = new Set();
      let invalid = 0;
      let duplicates = 0;

      recipients = [];

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
        recipients.push({ name, email });
      });

      $("csvSummary").textContent =
        `${recipients.length} valid unique recipients | ` +
        `${invalid} invalid rows | ${duplicates} duplicates.`;

      status("CSV loaded. Checking saved campaign...");
      await refreshCampaign();

    } catch (error) {
      status("CSV error: " + error.message);
    }
  });

  $("saveBtn").addEventListener("click", async () => {
    const settings = {
      subject: $("subject").value,
      message: $("message").value
    };

    try {
      await chrome.storage.local.set({
        biDraftSettings: settings
      });
      status("Draft settings saved.");
    } catch (error) {
      status("Save error: " + error.message);
    }
  });

  startBtn.addEventListener("click", async () => {
    try {
      if (currentCampaign?.status === "paused") {
        await sendAction("RESUME_CAMPAIGN");
        status("Saved campaign resumed.");
        await refreshCampaign();
        return;
      }

      if (currentCampaign) {
        status("An existing campaign is present. It cannot be replaced automatically.");
        return;
      }

      if (!recipients.length) {
        status("Upload your buyer CSV first.");
        return;
      }

      if (!$("permissionCheck").checked) {
        status("Confirm authorization before starting.");
        return;
      }

      const subject = $("subject").value.trim();
      const message = $("message").value.trim();

      if (!subject || !message) {
        status("Subject and message are required.");
        return;
      }

      if (!/(unsubscribe|opt.?out|reply\s+stop)/i.test(message)) {
        status("Add a clear opt-out instruction to your email.");
        return;
      }

      const suppressedEmails = $("suppressedEmails").value
        .split(/\r?\n/)
        .map(email => email.trim().toLowerCase())
        .filter(validEmail);

      const suppressed = new Set(suppressedEmails);

      const eligibleRecipients = recipients
        .filter(r => !suppressed.has(r.email))
        .map(r => r.email);

      if (!eligibleRecipients.length) {
        status("No eligible recipients remain after opt-out filtering.");
        return;
      }

      if (!confirm(
        `Start campaign for ${eligibleRecipients.length} recipients? ` +
        "Emails will be spaced 240 seconds apart."
      )) return;

      startBtn.disabled = true;
      status("Authorizing Gmail...");

      await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken(
          { interactive: true },
          token => {
            if (chrome.runtime.lastError || !token) {
              reject(new Error(
                chrome.runtime.lastError?.message ||
                "Gmail authorization failed."
              ));
            } else {
              resolve(token);
            }
          }
        );
      });

      await sendAction("START_CAMPAIGN", {
        recipients: eligibleRecipients,
        suppressedEmails,
        subject,
        message
      });

      status("Campaign started. First email is being processed.");
      await refreshCampaign();

    } catch (error) {
      status("Campaign error: " + error.message);
      await refreshCampaign();
    }
  });

  pauseBtn.addEventListener("click", async () => {
    try {
      await sendAction("PAUSE_CAMPAIGN");
      status("Campaign paused. Saved progress is retained.");
      await refreshCampaign();
    } catch (error) {
      status(error.message);
    }
  });

  stopBtn.addEventListener("click", async () => {
    if (!confirm(
      "Stop this campaign? Its sent history will be retained."
    )) return;

    try {
      await sendAction("STOP_CAMPAIGN");
      status("Campaign stopped. Sent history is retained.");
      await refreshCampaign();
    } catch (error) {
      status(error.message);
    }
  });

  chrome.storage.local.get("biDraftSettings", result => {
    const saved = result.biDraftSettings;

    if (saved) {
      $("subject").value = saved.subject || "";
      $("message").value = saved.message || "";
    }
  });

  refreshCampaign();
  setInterval(refreshCampaign, 5000);
});
