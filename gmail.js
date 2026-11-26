
const BIEmail = {
  async getToken() {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken(
        { interactive: true },
        result => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!result || !result.token) {
            reject(new Error("Google authorization failed."));
            return;
          }

          resolve(result.token);
        }
      );
    });
  },

  async sendOneTest({ email, subject, message, photos = [] }) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "")) {
      throw new Error("Invalid recipient email.");
    }

    if (!subject || !message) {
      throw new Error("Subject and message are required.");
    }

    if (photos.length > 3) {
      throw new Error("Maximum 3 photos allowed.");
    }

    const token = await this.getToken();
    const boundary = "BI_" + crypto.randomUUID();

    const headers = [
      "To: " + email,
      "Subject: " + this.encodeHeader(subject),
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`
    ];

    let mime = headers.join("\r\n") + "\r\n\r\n";

    mime += `--${boundary}\r\n`;
    mime += 'Content-Type: text/plain; charset="UTF-8"\r\n';
    mime += "Content-Transfer-Encoding: base64\r\n\r\n";
    mime += this.toBase64(message) + "\r\n";

    for (const photo of photos) {
      const bytes = await photo.arrayBuffer();
      const base64 = this.bytesToBase64(bytes);

      mime += `--${boundary}\r\n`;
      mime += `Content-Type: ${photo.type || "application/octet-stream"}; name="${photo.name}"\r\n`;
      mime += "Content-Transfer-Encoding: base64\r\n";
      mime += `Content-Disposition: attachment; filename="${photo.name}"\r\n\r\n`;
      mime += base64.replace(/.{1,76}/g, "$&\r\n") + "\r\n";
    }

    mime += `--${boundary}--`;

    const raw = this.bytesToBase64(
      new TextEncoder().encode(mime).buffer
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ raw })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error?.message || "Gmail sending failed.");
    }

    return {
      success: true,
      messageId: result.id,
      recipient: email
    };
  },

  encodeHeader(value) {
    return "=?UTF-8?B?" + this.toBase64(value) + "?=";
  },

  toBase64(value) {
    return btoa(
      unescape(encodeURIComponent(value))
    );
  },

  bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";

    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(
        ...bytes.subarray(i, i + 8192)
      );
    }

    return btoa(binary);
  }
};
