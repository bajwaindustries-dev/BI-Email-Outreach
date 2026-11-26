
document.addEventListener("DOMContentLoaded", () => {
  const csvInput = document.getElementById("csvFile");
  const photoInput = document.getElementById("photos");
  const saveBtn = document.getElementById("saveBtn");
  const status = document.getElementById("status");

  let csvRows = [];

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
      const text = await file.text();
      const rows = parseCSV(text);

      if (rows.length < 2) {
        showStatus("CSV file is empty or invalid.");
        return;
      }

      const headers = rows[0].map(h =>
        h.replace(/^\uFEFF/, "").trim().toLowerCase()
      );

      const nameIndex = headers.indexOf("name");
      const emailIndex = headers.indexOf("email");
      const phoneIndex = headers.indexOf("phone");

      if (nameIndex === -1 || emailIndex === -1 || phoneIndex === -1) {
        showStatus("CSV headings must be Name, Email, Phone.");
        return;
      }

      const seen = new Set();
      let invalid = 0;

      csvRows = rows.slice(1).map(row => ({
        name: row[nameIndex] || "",
        email: (row[emailIndex] || "").trim().toLowerCase(),
        phone: row[phoneIndex] || ""
      })).filter(person => {
        const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email);

        if (!valid) {
          invalid++;
          return false;
        }

        if (seen.has(person.email)) return false;

        seen.add(person.email);
        return true;
      });

      showStatus(
        `CSV loaded: ${csvRows.length} valid emails. ${invalid} invalid rows.`
      );

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

  chrome.storage.local.get("biDraftSettings", result => {
    const saved = result.biDraftSettings;

    if (saved) {
      document.getElementById("subject").value = saved.subject || "";
      document.getElementById("message").value = saved.message || "";
    }
  });
});
