#!/usr/bin/env bun
/**
 * ASCII TUI — live status of the RobotMoney local testnet containers.
 * Usage:  bun scripts/testnet.ts [--once]
 */

import { $ } from "bun";

const REFRESH_MS = 2000;
const once = process.argv.includes("--once");

// ── Container groups ─────────────────────────────────────────────────────────

const GROUPS: { label: string; containers: string[] }[] = [
  {
    label: "Chain",
    containers: ["eth-execution", "eth-beacon"],
  },
  {
    label: "Validators",
    containers: ["eth-validator-1", "eth-validator-2", "eth-validator-3", "eth-validator-4"],
  },
  {
    label: "dApp Stack",
    containers: ["dapp-postgres", "dapp-explorer-indexer", "dapp-explorer-api", "dapp-frontend"],
  },
];

// ── Synthwave palette ─────────────────────────────────────────────────────────

const A = {
  reset:      "\x1b[0m",
  bold:       "\x1b[1m",
  hotPink:    "\x1b[95m",   // bright magenta — borders, accents
  neonCyan:   "\x1b[96m",   // bright cyan    — healthy, section headers
  neonGreen:  "\x1b[92m",   // bright green   — running
  neonYellow: "\x1b[93m",   // electric yellow — warnings / restarting
  electricBlue:"\x1b[94m",  // electric blue  — ports
  laserRed:   "\x1b[91m",   // bright red     — errors / exited
  purple:     "\x1b[35m",   // purple         — dim frame elements
  white:      "\x1b[97m",   // bright white   — title
  dusk:       "\x1b[90m",   // dim gray       — placeholders / hints
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContainerInfo {
  name:   string;
  status: string;   // running | exited | created | paused | restarting
  health: string;   // healthy | unhealthy | starting | none
  ports:  string[]; // e.g. ["18545→8545", "5173"]
}

// ── Docker inspect ────────────────────────────────────────────────────────────

async function inspectContainers(names: string[]): Promise<Map<string, ContainerInfo>> {
  const result = new Map<string, ContainerInfo>();

  try {
    const proc = await $`docker inspect ${names}`.quiet().nothrow();
    if (proc.exitCode !== 0 || !proc.stdout.toString().trim()) return result;

    const data: any[] = JSON.parse(proc.stdout.toString());

    for (const c of data) {
      const name   = (c.Name as string).replace(/^\//, "");
      const status = (c.State.Status as string).toLowerCase();
      const health = (c.State.Health?.Status as string | undefined)?.toLowerCase() ?? "none";

      // Use NetworkSettings.Ports (actual live bindings)
      const ports: string[] = [];
      const netPorts: Record<string, { HostPort: string }[] | null> =
        c.NetworkSettings?.Ports ?? {};
      for (const [containerPort, bindings] of Object.entries(netPorts)) {
        if (!Array.isArray(bindings) || bindings.length === 0) continue;
        const host      = bindings[0].HostPort;
        const container = containerPort.replace(/\/(tcp|udp)$/, "");
        ports.push(host === container ? host : `${host}→${container}`);
      }
      ports.sort((a, b) => parseInt(a) - parseInt(b));

      result.set(name, { name, status, health, ports });
    }
  } catch {
    // docker unavailable — return empty map
  }

  return result;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

/** Visible length — strips ANSI escape codes. */
function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Right-pad s to n visible characters. */
function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - vlen(s)));
}

function statusColor(s: string): string {
  return s === "running"    ? A.neonGreen
       : s === "exited"     ? A.laserRed
       : s === "restarting" ? A.neonYellow
       :                      A.neonYellow;
}

function statusIcon(s: string): string {
  return s === "running" ? "◆"
       : s === "exited"  ? "◇"
       : s === "paused"  ? "◈"
       :                   "◌";
}

// health column — always 9 visible chars
function healthStr(h: string): string {
  return h === "healthy"   ? `${A.neonCyan}healthy  ${A.reset}`
       : h === "unhealthy" ? `${A.laserRed}unhealthy${A.reset}`
       : h === "starting"  ? `${A.neonYellow}starting ${A.reset}`
       :                     `${A.dusk}—        ${A.reset}`;
}

// ── Frame ─────────────────────────────────────────────────────────────────────

const W = 74; // total width including border chars

function b(s: string): string { return `${A.hotPink}${s}${A.reset}`; }

/** Single-content row — fills trailing space automatically. */
function row(content: string): string {
  const fill = Math.max(0, W - 2 - 1 - vlen(content) - 1);
  return b("║") + " " + content + " ".repeat(fill) + " " + b("║");
}

/** Two-column row — left flush, right flush against the border. */
function rowLR(left: string, right: string): string {
  const gap = Math.max(1, W - 2 - 1 - vlen(left) - vlen(right) - 1);
  return b("║") + " " + left + " ".repeat(gap) + right + " " + b("║");
}

function sectionHeader(label: string): string {
  const dashes = W - 4 - label.length - 2;
  return row(
    `${A.bold}${A.hotPink}${label}${A.reset}  ${A.purple}${"╌".repeat(Math.max(0, dashes))}${A.reset}`
  );
}

// ── Overall status badge ──────────────────────────────────────────────────────

function overallBadge(infos: Map<string, ContainerInfo>): string {
  const all     = GROUPS.flatMap(g => g.containers);
  const found   = all.filter(n => infos.has(n));
  const running = found.filter(n => infos.get(n)!.status === "running");
  const healthy = found.filter(n => {
    const h = infos.get(n)!.health;
    return h === "healthy" || h === "none"; // no-healthcheck containers count as fine
  });

  if (found.length === 0)            return `${A.dusk}no containers${A.reset}`;
  if (running.length < all.length)   return `${A.laserRed}◆ ${running.length}/${all.length} running${A.reset}`;
  if (healthy.length < found.length) return `${A.neonYellow}◆ ${found.length - healthy.length} unhealthy${A.reset}`;
  return `${A.neonGreen}◆ all healthy${A.reset}`;
}

// ── Frame renderer ────────────────────────────────────────────────────────────

function render(infos: Map<string, ContainerInfo>, ts: Date): string {
  const lines: string[] = [];

  const top = b("╔" + "═".repeat(W - 2) + "╗");
  const mid = b("╠" + "═".repeat(W - 2) + "╣");
  const bot = b("╚" + "═".repeat(W - 2) + "╝");
  const gap = row("");

  lines.push(top);
  lines.push(rowLR(
    `  ${A.bold}${A.neonCyan}✦ ROBOTMONEY TESTNET${A.reset}`,
    `${A.dusk}${ts.toLocaleTimeString()}${A.reset}  ${overallBadge(infos)}  `,
  ));
  lines.push(mid);

  for (const group of GROUPS) {
    lines.push(sectionHeader(group.label));

    for (const name of group.containers) {
      const info = infos.get(name);

      if (!info) {
        lines.push(rowLR(
          `  ${A.dusk}◌ ${pad(name, 26)}  not found${A.reset}`,
          "",
        ));
        continue;
      }

      const sc      = statusColor(info.status);
      const icon    = `${sc}${statusIcon(info.status)}${A.reset}`;
      // Fixed visible widths: name=26  status=11  health=9  → left prefix = 54 visible
      const nameCol = pad(`${sc}${name}${A.reset}`,        26);
      const statCol = pad(`${sc}${info.status}${A.reset}`, 11);
      const hlth    = healthStr(info.health);

      // Ports right-aligned, capped at 15 visible chars
      let portsVisible = info.ports.join("  ");
      if (portsVisible.length > 15) portsVisible = portsVisible.slice(0, 14) + "…";
      const portsCol = portsVisible.length
        ? `${A.electricBlue}${portsVisible}${A.reset}`
        : `${A.dusk}—${A.reset}`;

      lines.push(rowLR(
        `  ${icon} ${nameCol}  ${statCol}  ${hlth}`,
        portsCol,
      ));
    }

    lines.push(gap);
  }

  lines.push(bot);

  const hint = once
    ? `  ${A.dusk}snapshot only${A.reset}`
    : `  ${A.purple}auto-refresh ${REFRESH_MS / 1000}s${A.reset}  ${A.dusk}•  Ctrl+C to quit${A.reset}`;
  lines.push(hint);

  return lines.join("\n");
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const ALL_NAMES = GROUPS.flatMap(g => g.containers);

async function tick() {
  const infos  = await inspectContainers(ALL_NAMES);
  const output = render(infos, new Date());
  if (!once) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(output + "\n");
}

process.on("SIGINT", () => {
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
});

if (once) {
  await tick();
} else {
  while (true) {
    await tick();
    await Bun.sleep(REFRESH_MS);
  }
}
