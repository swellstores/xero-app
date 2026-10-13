<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Xero needs attention</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;">
            <tr>
              <td style="padding:32px;">
                {% if key == 'connection' %}
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;">Xero is not accepting documents from {{ store.name }}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">{{ message }}</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">Until this is corrected, no invoices or credit notes are created. Nothing is lost: every order and refund that should have a document is listed under Orders > Xero documents > Needs attention.</p>
                <p style="margin:0 0 8px;font-size:15px;line-height:24px;font-weight:600;">To fix it</p>
                <ol style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:24px;">
                  <li>In Xero's developer portal (developer.xero.com, My Apps), open the custom connection. Check that it is connected to your organisation and has the scopes accounting.contacts, accounting.invoices, accounting.payments and accounting.settings.read.</li>
                  <li>In Swell, open Apps > Xero > Settings, enter the client ID and secret, save and press Test connection.</li>
                  <li>Choose Retry failed documents in the Actions menu of the same page.</li>
                </ol>
                {% else %}
                <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;">A Xero document could not be created</h1>
                {% if subject %}<p style="margin:0 0 8px;font-size:15px;line-height:24px;font-weight:600;">{{ subject }}</p>{% endif %}
                <p style="margin:0 0 16px;font-size:15px;line-height:24px;">{{ message }}</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:24px;">It is listed under Orders > Xero documents > Needs attention, where you can retry it after correcting the cause, or mark it as resolved after creating the document in Xero by hand. You will not get another e-mail while documents are waiting there.</p>
                {% endif %}
                <p style="margin:0 0 24px;">
                  <a href="{{ store.admin_url }}/admin/apps{% if app_id %}/{{ app_id }}{% if key == 'connection' %}?tab=settings{% endif %}{% endif %}" style="display:inline-block;padding:10px 20px;background-color:#1f2933;color:#ffffff;font-size:15px;line-height:20px;text-decoration:none;border-radius:6px;">Open the Xero app</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:20px;color:#616e7c;">If the subject of this e-mail starts with (TEST), the problem is in your store's test environment: switch the dashboard to it after opening the app.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
