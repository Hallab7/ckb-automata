import type { Metadata } from "next";

import { TransactionProgressFixture } from "../../../../src/setup/transaction-progress.fixture.tsx";

export const metadata: Metadata = {
  title: "Transaction progress fixture",
};

export default function TransactionProgressFixturePage() {
  return <TransactionProgressFixture />;
}
