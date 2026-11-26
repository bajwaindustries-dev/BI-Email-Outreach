
document.addEventListener("DOMContentLoaded", () => {
  const csvInput = document.getElementById("csvFile");
  const photoInput = document.getElementById("photos");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testSendBtn");
  const status = document.getElementById("status");

  function showStatus(message) {
    status.textContent = message;
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

      if (
        !headers.includes("name") ||
        !headers.includes("email") ||
        !headers.includes("phone")
      ) {
        showStatus("CSV headings must be Name, Email, Phone.");
        return;
      }

      const emailIndex = headers.indexOf("email");
      const seen = new Set();
      let valid = 0;
      let invalid = 0;

      rows.slice(1).forEach(row => {
        const email = (row[emailIndex] || "").trim().toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          invalid++;
        } else if (!seen.has(email)) {
          seen.add(email);
          valid++;
        }
      });

      showStatus(`CSV checked: ${valid} valid unique emails, ${invalid} invalid rows. No emails sent.`);
    } catch (error) {
      showStatus("CSV error: " + error.message);
    }
  });

  saveBtn.addEventListener("click", async () => {
    const photos = photoInput.files;

    if (photos.length > 3) {
      showStatus("Maximum 3 photos allowed.");
      return;
    }

    const settings = {
      subject: document.getElementById("subject").value,
      message: document.getElementById("message").value,
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
    const email = document.getElementById("testEmail").value.trim();
    const subject = document.getElementById("subject").value.trim();
    const message = document.getElementById("message").value.trim();
    const photos = Array.from(photoInput.files);
    const permission = document.getElementById("permissionCheck").checked;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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

      showStatus(`Test email accepted by Gmail for ${result.recipient}. Message ID: ${result.messageId}`);
    } catch (error) {
      showStatus("Sending error: " + (error.message || "Unknown error"));
    } finally {
      testBtn.disabled = false;
    }
  });

  chrome.storage.local.get("biDraftSettings", result => {
    const saved = result.biDraftSettings;
    if (saved) {
      document.getElementById("subject").value = saved.subject || "";
      document.getElementById("message").value = saved.message || "";
    }
  });
});
