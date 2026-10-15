# Xero for Swell

Creates invoices and credit notes in [Xero](https://www.xero.com/) for a Swell store's orders, and records their payments. An order that becomes paid gets an invoice, which arrives in Xero as paid. A refund gets a credit note for the same customer, which is paid out from the account the refund's payment method has. Each document is shown on its order in Swell, with its number, its status in Xero and a link into Xero.

Data flows one way, from Swell to Xero, through the merchant's own Xero custom connection. The app reads orders, payments and customers. It writes only its own records in Swell, and only new contacts, invoices, credit notes and payments in Xero.

## Setup

1. Install the app from Apps in the Swell dashboard.
2. In Xero's developer portal (developer.xero.com, My Apps), choose **New app**, name it, and choose **Custom connection**. Select the scopes `accounting.contacts`, `accounting.invoices`, `accounting.payments` and `accounting.settings.read`, and the user who authorises it. That user gets an e-mail, connects the app and chooses the organisation. Then copy the **Client id** on the app's page and generate a **Client secret**.
3. In Swell, open Apps > Xero > Settings, enter **Client ID** and **Client secret**, save, and press **Test connection**. It fills in **Connected organisation**, and says how invoices are created and how the accounts, tax rates and payment settings match the organisation.
4. Under **Invoices**, choose:
   - **Create invoices as**: drafts or approved invoices. New installs create drafts.
   - **Account for sales**: the code or name of the account item sales are posted to, for example `Sales`.
   - **Account for shipping**: the account for shipping charges. Empty: the account for sales.
   - **Create credit notes for refunds**: on for new installs.
5. Under **Tax rates**, name a Xero tax rate for each percentage that Xero has more than one sales tax rate for. Test connection lists them. US organisations name the account for sales tax here instead.
6. Under **Payments**, enter the account for shop payments, and add a row under **Payment method exceptions** for each method that arrives elsewhere. See "Payments".
7. Turn on **Send paid orders and refunds to Xero**. Until then nothing is created by itself; the buttons work either way.

Settings are separate for the store's test and live environments, and both start empty. Custom connections are available to organisations in Australia, New Zealand, the United Kingdom and the United States. Xero charges the organisation a monthly fee for each custom connection; connecting the Demo Company is free, which suits the test environment.

## What is created

| In Swell | In Xero |
| --- | --- |
| An order becomes paid | An invoice, and a payment for each of the order's payments |
| A payment of an invoiced order is refunded, in part or in full | A credit note for the invoice's contact, and the refund paid out |
| A customer's first order | A contact. Later orders use it again |
| **Create Xero invoice** on an order, or **Create Xero invoices** on selected orders | An invoice, paid or not |

**The invoice.** For the customer's contact, dated the day the order was placed in the organisation's time zone. The order number is in Xero's Reference field. One line per order item with its quantity and unit price, and a discount on the line it belongs to; one line for shipping. Xero numbers the invoice, and the layout and branding are the organisation's. A paid order's invoice is due on its date. An unpaid order's invoice gets the organisation's sales payment terms.

**Tax.** Each line gets the Xero sales tax rate with the percentage the store charged on it: the one active rate with that percentage, or the one named under Tax rates. When Xero has several, or none, the document waits under Needs attention until one is named. Xero calculates the tax from the rate. A store with prices before tax gets a tax-exclusive invoice when Xero's per-line rounding gives the order's total; otherwise the lines are sent with tax included, so the total is always the order's.

**US organisations.** Xero's US sales tax rates cannot be used through the API. The lines carry no tax, and the order's sales tax is a line of its own on the account named under Tax rates, usually Sales Tax Payable.

**The credit note.** A refund in Swell is an amount and names no items. A refund of the whole invoice repeats the invoice's lines. A partial refund becomes one line per account and tax rate of the invoice, in proportion to what the invoice holds on each, with tax included.

**The contact.** The customer is looked for among the contacts the app used before, then in Xero by the Swell customer ID (Xero's Contact Code) and by e-mail address. If there is none, a contact is created with the billing address, e-mail address and phone. Xero needs unique contact names: when the name is taken, the e-mail address is added to it. Existing contacts are never changed.

## Payments

Xero records a payment on a bank account, or on an account with "Enable payments to this account".

- **Account for shop payments**: the code or name of the account. Each payment of an order is recorded there with its own amount and date. A clearing account for your payment provider works well: transfer each payout from it to your bank account in Xero.
- **Payment method exceptions**: a row per payment method that does not arrive on that account. Give it another account, or no account to record nothing for it. Recording nothing is right for bank transfers you reconcile from the bank feed.
- **Gift cards and store credit** are not recorded unless they have a row with an account.
- **Refunds** are paid out from the account of the refund's payment method, when the app recorded the order's payments. Otherwise the credit note stays open, to reconcile with the refund from the bank feed.
- With no account at all, nothing is recorded and invoices stay awaiting payment in Xero.

Payments are recorded only on approved invoices. A draft gets its payments when it is approved.

## Drafts and approved invoices

Every document starts in Xero as a **draft**, and its total is compared with the order. A draft can be edited and deleted in Xero. **Approving** it makes it final, and then the app records the payments.

- New installs stop at the draft until **Create invoices as** is set to approved invoices.
- To approve a draft from Swell, open the document and choose **Approve draft**, or select several on the **Drafts** tab and choose **Approve drafts**.
- After approving a draft in Xero itself, choose **Read again from Xero** on the document in Swell: the app records its payments.
- A refund of an order whose invoice is still a draft waits under Needs attention.
- Xero's Starter plan approves a limited number of invoices a month. Beyond that, the invoice stays a draft and is listed under Needs attention. Approve it in Xero once the plan allows it, then choose **Retry** on the document.

## In the dashboard

- **Orders > Xero documents** lists every invoice and credit note, with tabs for **Needs attention**, **In Xero**, **Drafts** and **Skipped**. A document's page shows the number, the status in Xero, the tax rates, what was paid, and has **View in Xero**.
- **The order's Xero tab** shows the order's documents. **Create Xero invoice** is in the order's Actions menu.
- A document that needs attention has **Retry** and **Mark as resolved**. Resolve it after creating the document in Xero by hand, or when none is needed: the app will then not create it.
- **Retry failed documents**, in the Actions menu of the app's settings page, retries everything under Needs attention.

The buttons start a run in the background. Through the API, an order's documents expand as `$app.xero.documents`.

## When something goes wrong

| What happens | What the app does |
| --- | --- |
| Xero is down, offline for maintenance, or limits the calls | The run tries again for about ten minutes. After that the document is tried again every half hour, for a day. Then it is listed under Needs attention |
| An answer from Xero is lost | The request is sent again with the same idempotency key, and the app looks for its draft by the reference before it creates another. Before recording a payment it reads the payments it recorded on the invoice before, which carry the reference "Swell order", and records no more than is due |
| The same event arrives twice | The second one finds the document's record and continues it, or finds nothing left to do |
| Xero refuses the client ID and secret, or the connection lacks a scope | Affected documents are listed under Needs attention. The store's administrators get one e-mail. After the connection is fixed, **Retry failed documents** creates them |
| Xero refuses a document, or no invoice can be built | Listed under Needs attention with the reason. The administrators get one e-mail while such documents wait, not one per order |
| A draft is deleted in Xero | The document is listed under Needs attention. **Retry** creates it again |

## Development

```bash
npm install
npm test
npm run typecheck
```

The tests run against a small fake of Xero (`test/helpers/xero.ts`) and of the store API (`test/helpers/store.ts`).
