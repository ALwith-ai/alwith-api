# npm 0.1.0 license review

The proprietary development and redistribution license (v1.0) has been written into the four npm packages. The licensor entity follows the existing U LICENSE, ALWITHAI PTE. LTD., and only ALwith-owned code is covered. It allows commercial use, in-app distribution, modifying the supplied JS, and combining with MPL applications; it does not require registering applications, promise absolute disclaimers, or fix any unconfirmed court or compensation amount.

## Still to be completed before release

- The owner confirms the company entity and the licensing rights over code from employees, contractors and copied code; a lawyer reviews the proprietary terms and the account service terms. This file and the auto-generated notices are not proof of legal review.
- The provenance of Chat's shadcn UI has a structure and a Desktop migration record; PromptInput is marked as vendor but lacks an exact upstream version. The Vercel AI Elements Apache notice is conservatively retained; the original imported version, the full NOTICE and the per-file scope must be verified, and it cannot be claimed that a full provenance audit is complete.
- No full license text was found in either the smplr npm package or its official repo; the metadata says MIT. The complete license and copyright notice for 1.0.0 must be confirmed with upstream and must not be invented. Licenses for the instrument sample media are separate and are not automatically obtained through the library's MIT.
- External dependencies are not bundled into this package; when an app is packaged, notices for the actual dependency versions and transitive dependencies are compiled separately.
- 2026-09-16: after being made aware of the review items above, the user explicitly asked to publish first. The four packages had the private publish lock removed and npm 0.1.0 was published; the repo remains private. The provenance and legal reviews above are still incomplete, and a successful publish does not mean legal review has passed.

## Gradual open-sourcing

For now only U is planned to be open-sourced; this change does not modify U's existing license or open any repository. npm packages may later be open-sourced per version, which requires the corresponding rights; this cannot overwrite older npm versions or revoke compliance grants for them. The Runtime, and the Rust, QA, alwith.dev and similar parts in mixed repos, are not automatically covered by these four npm licenses.
