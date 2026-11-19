# Payment provider fixtures

Response and webhook bodies used by `payment-contract.test.ts`. They follow the shapes in each
provider's API reference (fields Shopkit does not read are trimmed). The cashfree order id and the
amounts match what the contract's session input produces. When a provider changes its API, record
a real sandbox response with keys removed and replace the file.
