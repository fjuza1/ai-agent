import { DisclaimerBar, PolicyLinks } from "../trust/LegalDisclaimers";

export default function ComplianceFooter() {
  return <footer className="border-t p-6 text-sm max-w-6xl mx-auto"><DisclaimerBar /><p className="mt-2">Verify product labels and suitability before purchase.</p><PolicyLinks /></footer>;
}
