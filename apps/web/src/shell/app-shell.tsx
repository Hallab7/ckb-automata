"use client";

import {
  Activity,
  Beaker,
  Bot,
  FlaskConical,
  Menu,
  Network,
  Plus,
  Settings,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";

import { Drawer, IconButton, OverlayClose } from "@ckb-automata/ui";

import { WalletNetworkNotice } from "../ccc/session.tsx";
import { WalletControl } from "../ccc/wallet-control.tsx";
import { NotificationCenter } from "./notification-center.tsx";

interface NavigationItem {
  readonly exact?: boolean;
  readonly href: string;
  readonly icon: ComponentType<Readonly<{ "aria-hidden"?: "true"; size?: number }>>;
  readonly label: string;
}

const primaryNavigation: readonly NavigationItem[] = [
  { href: "/automations", icon: Bot, label: "Automations" },
  { href: "/automations/new", icon: Plus, label: "New automation" },
  { href: "/activity", icon: Activity, label: "Activity" },
];

const secondaryNavigation: readonly NavigationItem[] = [
  { href: "/demo", icon: Beaker, label: "Demo" },
  { href: "/research/nervdao", icon: FlaskConical, label: "NervDAO research" },
  { href: "/settings", icon: Settings, label: "Settings" },
  { href: "/limitations", icon: ShieldCheck, label: "Privacy & limitations" },
];

function isActive(pathname: string, item: NavigationItem): boolean {
  if (item.href === "/automations" && pathname.startsWith("/automations/new")) return false;
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavigationLinks({ closeOnSelect = false }: Readonly<{ closeOnSelect?: boolean }>) {
  const pathname = usePathname();

  function links(items: readonly NavigationItem[]) {
    return items.map((item) => {
      const Icon = item.icon;
      const link = (
        <Link
          aria-current={isActive(pathname, item) ? "page" : undefined}
          className="app-nav__link"
          href={item.href}
          key={item.href}
        >
          <Icon aria-hidden="true" size={18} />
          <span>{item.label}</span>
        </Link>
      );
      return closeOnSelect ? <OverlayClose key={item.href}>{link}</OverlayClose> : link;
    });
  }

  return (
    <nav aria-label="Primary" className="app-nav">
      <div className="app-nav__group">{links(primaryNavigation)}</div>
      <div className="app-nav__divider" />
      <div className="app-nav__group">{links(secondaryNavigation)}</div>
    </nav>
  );
}

function ProductMark() {
  return (
    <Link aria-label="CKB Automata home" className="app-brand" href="/automations">
      <span aria-hidden="true" className="app-brand__mark">
        <Network size={19} />
      </span>
      <span className="app-brand__copy">
        <strong>CKB Automata</strong>
        <small>Non-custodial automation</small>
      </span>
    </Link>
  );
}

function NetworkBadge() {
  const demo = usePathname() === "/demo";
  return (
    <span className="app-network-badge" data-mode={demo ? "demo" : "live"}>
      <span aria-hidden="true" className="app-network-badge__dot" />
      {demo ? (
        <span>Demo data</span>
      ) : (
        <span>
          <span className="app-network-badge__prefix">CKB </span>
          Testnet
        </span>
      )}
    </span>
  );
}

function WalletArea() {
  const demo = usePathname() === "/demo";
  if (!demo) return <WalletControl />;
  return (
    <div className="app-wallet-control app-wallet-control--demo">
      <div className="app-wallet-control__heading">
        <div>
          <span className="app-wallet-control__label">Demo boundary</span>
          <strong>Wallet disabled</strong>
        </div>
        <Beaker aria-hidden="true" size={18} />
      </div>
      <p>Demo mode cannot request signatures or submit transactions.</p>
    </div>
  );
}

function NetworkNotice() {
  return usePathname() === "/demo" ? null : <WalletNetworkNotice />;
}

function MobileNavigation() {
  return (
    <Drawer
      description="Move between automation workspaces."
      title="Navigation"
      trigger={
        <IconButton
          className="app-mobile-menu-button"
          icon={<Menu aria-hidden="true" size={20} />}
          label="Open navigation"
          showTooltip={false}
          tone="secondary"
        />
      }
    >
      <div className="app-mobile-nav">
        <NetworkBadge />
        <NavigationLinks closeOnSelect />
        <WalletArea />
      </div>
    </Drawer>
  );
}

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="app-shell">
      <a className="app-skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="app-sidebar">
        <ProductMark />
        <NetworkBadge />
        <NavigationLinks />
        <WalletArea />
      </aside>
      <div className="app-shell__workspace">
        <header className="app-mobile-header">
          <ProductMark />
          <div className="app-mobile-header__actions">
            <NetworkBadge />
            <MobileNavigation />
          </div>
        </header>
        <div className="app-mobile-wallet">
          <WalletArea />
        </div>
        <main className="app-main" id="main-content" tabIndex={-1}>
          <NetworkNotice />
          {children}
        </main>
      </div>
      <NotificationCenter />
    </div>
  );
}
