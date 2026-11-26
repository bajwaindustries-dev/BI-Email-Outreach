
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

      reader.onload = () => {
        const result = reader.result;
        resolve(result.split(",")[1]);
      };

      reader.onerror = () => reject(new Error("Could not read attachment."));
      reader.readAsDataURL(file);
    });
  }

  function encodeSubject(subject) {
    const bytes = new TextEncoder().encode(subject);
    let binary = "";

    bytes.forEach(byte => {
      binary += String.fromCharCode(byte);
    });

    return "=?UTF-8?B?" + btoa(binary) + "?=";
  }

  function wrapBase64(value) {
    return value.match(/.{1,76}/g)?.join("\r\n") || "";
  }

  async function sendOneTest({ email, subject, message, photos = [] }) {
    if (photos.length > 3) {
      throw new Error("Maximum 3 photos allowed.");
    }

    const token = await getToken();
    const boundary = "BI_BOUNDARY_" + Date.now();

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
      wrapBase64(
        btoa(
          Array.from(
            new TextEncoder().encode(message),
            byte => String.fromCharCode(byte)
          ).join("")
        )
      )
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

    const raw = btoa(
      Array.from(
        new TextEncoder().encode(mime),
        byte => String.fromCharCode(byte)
      ).join("")
    )
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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error?.message || `Gmail API error: ${response.status}`
      );
    }

    return {
      recipient: email,
      messageId: data.id
    };
  }

  return { sendOneTest };
})();
