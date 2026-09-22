import { Module } from "@nestjs/common";

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class AppModule {}

Module({})(AppModule);
