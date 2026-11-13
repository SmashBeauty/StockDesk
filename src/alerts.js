// Negative-stock alert email via Resend (https://resend.com). Needs RESEND_API_KEY,
// ALERT_EMAIL (comma-separated recipients) and ALERT_FROM (a sender on a verified
// domain, or "Stock Desk <onboarding@resend.dev>" while testing). Without them, alerts
// are only shown on the Stock Desk dashboard.
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function alertConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL);
}

export function alertHtml(storeName, fresh, total, appUrl) {
  const rows = fresh
    .slice(0, 200)
    .map(
      (x) =>
        `<tr><td>${esc(x.title)}${x.variant ? " — " + esc(x.variant) : ""}</td><td>${esc(x.sku)}</td><td>${esc(x.barcode)}</td><td style="text-align:right;color:#B42318"><b>${x.onHand}</b></td><td>${esc(x.last || "—")}</td></tr>`
    )
    .join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px">
<p><b>${esc(storeName)}</b>: ${fresh.length} item${fresh.length === 1 ? "" : "s"} went below zero since the last check (${total} negative in total).</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd">
<tr style="background:#f4f5f8"><th align="left">Item</th><th align="left">SKU</th><th align="left">Barcode</th><th align="right">In stock</th><th align="left">Last sale</th></tr>
${rows}</table>
${fresh.length > 200 ? `<p>…and ${fresh.length - 200} more.</p>` : ""}
<p>Usually this means stock was sold before it was received, or a count is off. Check the shelf, then receive the PO or adjust the count${appUrl ? ` in <a href="${esc(appUrl)}">Stock Desk</a>` : " in Stock Desk"}.</p></div>`;
}

export async function sendAlert(storeName, fresh, total) {
  if (!alertConfigured()) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ALERT_FROM || "Stock Desk <onboarding@resend.dev>",
      to: process.env.ALERT_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
      subject: `${storeName}: ${fresh.length} item${fresh.length === 1 ? "" : "s"} below zero`,
      html: alertHtml(storeName, fresh, total, process.env.APP_URL || ""),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}
