"use client";

import {
  Activity,
  Bell,
  Beaker,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  FlaskConical,
  Landmark,
  Menu,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  WalletCards,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";

import { Drawer, IconButton, OverlayClose } from "@ckb-automata/ui";

import { useWalletSession, WalletNetworkNotice } from "../ccc/session.tsx";
import { WalletControl } from "../ccc/wallet-control.tsx";
import { formatCkbBalance, shortenCkbAddress } from "../ccc/wallet-display.ts";
import { NotificationCenter, publishNotification } from "./notification-center.tsx";

interface NavigationItem {
  readonly exact?: boolean;
  readonly href: string;
  readonly icon: ComponentType<Readonly<{ "aria-hidden"?: "true"; size?: number }>>;
  readonly label: string;
}

const primaryNavigation: readonly NavigationItem[] = [
  { href: "/automations", icon: BriefcaseBusiness, label: "Automations" },
  { href: "/automations/new", icon: CirclePlus, label: "New automation" },
  { href: "/activity", icon: Activity, label: "Activity" },
];

const secondaryNavigation: readonly NavigationItem[] = [
  { href: "/demo", icon: FlaskConical, label: "Demo" },
  { href: "/research/nervdao", icon: Landmark, label: "NervDAO research" },
  { href: "/settings", icon: SlidersHorizontal, label: "Settings" },
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
      <div className="app-nav__section">
        <span className="app-nav__label">Workspace</span>
        <div className="app-nav__group">{links(primaryNavigation)}</div>
      </div>
      <div className="app-nav__section">
        <span className="app-nav__label">Tools</span>
        <div className="app-nav__group">{links(secondaryNavigation)}</div>
      </div>
    </nav>
  );
}

function ProductMark() {
  return (
    <Link aria-label="CKB Automata home" className="app-brand" href="/automations">
      <span aria-hidden="true" className="app-brand__mark">
        <X size={19} strokeWidth={2.25} />
      </span>
      <span className="app-brand__copy">
        <strong>CKB Automata</strong>
        <small>Non-custodial automation</small>
      </span>
    </Link>
  );
}

function breadcrumbLabel(pathname: string): string {
  if (pathname.startsWith("/automations/new")) return "New automation";
  if (/^\/automations\/.+/.test(pathname)) return "Automation details";
  if (pathname.startsWith("/activity")) return "Activity";
  if (pathname.startsWith("/demo")) return "Demo";
  if (pathname.startsWith("/research/nervdao")) return "NervDAO research";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/limitations")) return "Privacy & limitations";
  return "Automations";
}

function showNotificationInfo() {
  publishNotification({
    id: "notification-center-ready",
    message: "Automation updates and transaction results will appear here.",
    title: "Notifications",
    tone: "info",
  });
}

function HeaderWallet() {
  const session = useWalletSession();
  const connected = session.status === "ready";
  const address = session.address === undefined ? undefined : shortenCkbAddress(session.address);
  const balance =
    session.balanceShannons === undefined ? undefined : formatCkbBalance(session.balanceShannons);

  return (
    <button
      aria-label={connected ? "Review connected wallet" : "Connect wallet"}
      className="app-header-wallet"
      onClick={session.open}
      type="button"
    >
      <span aria-hidden="true" className="app-header-wallet__avatar">
        <WalletCards size={14} />
      </span>
      <span className="app-header-wallet__copy">
        <strong>{address ?? (connected ? "Connected wallet" : "Connect wallet")}</strong>
        {balance === undefined ? null : <small>{balance}</small>}
      </span>
      <ChevronDown aria-hidden="true" size={15} />
    </button>
  );
}

function DesktopHeader() {
  const pathname = usePathname();
  const demo = pathname === "/demo";

  return (
    <header className="app-desktop-header">
      <nav aria-label="Breadcrumb" className="app-breadcrumb">
        <span>Workspace</span>
        <ChevronRight aria-hidden="true" size={15} />
        <strong>{breadcrumbLabel(pathname)}</strong>
      </nav>
      <div className="app-desktop-header__actions">
        <IconButton
          icon={<Bell aria-hidden="true" size={17} />}
          label="Notifications"
          onClick={showNotificationInfo}
          showTooltip={false}
          tone="secondary"
        />
        <IconButton
          icon={<RefreshCw aria-hidden="true" size={17} />}
          label="Refresh page"
          onClick={() => window.location.reload()}
          showTooltip={false}
          tone="secondary"
        />
        {demo ? (
          <div className="app-header-wallet app-header-wallet--static">
            <span aria-hidden="true" className="app-header-wallet__avatar">
              <Beaker size={14} />
            </span>
            <span className="app-header-wallet__copy">
              <strong>Demo data</strong>
              <small>Wallet disabled</small>
            </span>
          </div>
        ) : (
          <HeaderWallet />
        )}
      </div>
    </header>
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
        <DesktopHeader />
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
