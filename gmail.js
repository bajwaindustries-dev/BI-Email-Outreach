
const BIEmail = (() => {
  function getToken() {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, token => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!token) {
          reject(new Error("Google authorization token not received."));
          return;
        }

        resolve(token);
      });
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Could not read attachment."));

      reader.readAsDataURL(file);
    });
  }

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";

    bytes.forEach(byte => {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary);
  }

  function encodeSubject(subject) {
    return "=?UTF-8?B?" + encodeBase64(subject) + "?=";
  }

  function wrapBase64(value) {
    return value.match(/.{1,76}/g)?.join("\r\n") || "";
  }

  async function sendEmail({ email, subject, message, photos = [] }) {
    if (photos.length > 3) {
      throw new Error("Maximum 3 photos allowed.");
    }

    const token = await getToken();
    const boundary = "BI_BOUNDARY_" + crypto.randomUUID();

    let mime = [
      `To: ${email}`,
      `Subject: ${encodeSubject(subject)}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(encodeBase64(message))
    ].join("\r\n");

    for (const photo of photos) {
      if (!photo.type.startsWith("image/")) {
        throw new Error("Only image attachments are allowed.");
      }

      const base64 = await fileToBase64(photo);
      const safeName = photo.name.replace(/[\r\n"]/g, "_");

      mime += [
        "",
        `--${boundary}`,
        `Content-Type: ${photo.type}; name="${safeName}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${safeName}"`,
        "",
        wrapBase64(base64)
      ].join("\r\n");
    }

    mime += `\r\n--${boundary}--`;

    const raw = encodeBase64(mime)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

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

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error?.message || `Gmail API error: ${response.status}`
      );
    }

    return {
      recipient: email,
      messageId: result.id
    };
  }

  async function sendOneTest(data) {
    return sendEmail(data);
  }

  async function sendOneCampaignEmail(data) {
    return sendEmail(data);
  }

  return {
    sendOneTest,
    sendOneCampaignEmail
  };
})();
