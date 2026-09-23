import type { Metadata } from "next";

import { CreationReviewFixture } from "../../../../src/setup/creation-review.fixture.tsx";

export const metadata: Metadata = {
  title: "Transaction review fixture",
};

export default function TransactionReviewFixturePage() {
  return <CreationReviewFixture />;
}
