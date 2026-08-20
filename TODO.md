# TODO

- [ ] Add prepaid platform AI credits so clients pay before platform-funded inference is allowed.
  - Verify payment-provider webhooks and process them idempotently.
  - Maintain an auditable per-user credit ledger instead of a mutable balance alone.
  - Reserve and debit credits atomically for inference, with idempotent release or refund handling.
  - Block requests before model invocation when available credit is insufficient.
  - Reconcile provider-reported inference costs and expose transaction history to users and admins.
