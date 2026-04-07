// KCode - Web Engine: IoT/Device Monitoring Dashboard Template
// Next.js + React + Tailwind — fully machine-generated

import type { FileTemplate } from "../templates";

export function iotMonitoringComponents(): FileTemplate[] {
  return [
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IoT Monitor",
  description: "Device Monitoring Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-[#0a0a0a] text-white">
        {children}
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/app/page.tsx",
      content: `"use client";
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { SystemStatus } from "@/components/SystemStatus";
import { DeviceGrid } from "@/components/DeviceGrid";
import { AlertsPanel } from "@/components/AlertsPanel";
import { SensorTimeline } from "@/components/SensorTimeline";

export default function Home() {
  const [activeNav, setActiveNav] = useState("dashboard");

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      <Sidebar active={activeNav} onNavigate={setActiveNav} />
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-7xl mx-auto space-y-8">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-gray-400 mt-1">Real-time device monitoring</p>
          </div>
          <SystemStatus />
          <div className="grid lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              <DeviceGrid />
              <SensorTimeline />
            </div>
            <div>
              <AlertsPanel />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/Sidebar.tsx",
      content: `"use client";
import { Activity, Cpu, Bell, Signal, Gauge } from "lucide-react";

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
}

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: Activity },
  { id: "devices", label: "Devices", icon: Cpu },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "analytics", label: "Analytics", icon: Signal },
  { id: "settings", label: "Settings", icon: Gauge },
];

export function Sidebar({ active, onNavigate }: SidebarProps) {
  return (
    <aside className="w-64 border-r border-white/10 bg-[#0a0a0a] flex flex-col h-full flex-shrink-0 hidden md:flex">
      <div className="p-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-green-500 flex items-center justify-center">
            <Cpu className="w-4 h-4 text-black" />
          </span>
          <span>IoT<span className="text-green-400">Monitor</span></span>
        </h1>
      </div>
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={\`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition \${
                active === item.id
                  ? "bg-green-500/10 text-green-400 font-medium"
                  : "text-gray-400 hover:bg-white/5 hover:text-white"
              }\`}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="p-4 m-3 rounded-xl bg-[#141414] border border-white/10">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-xs text-gray-400">System Healthy</span>
        </div>
        <p className="text-xs text-gray-500">Last sync: 12s ago</p>
      </div>
    </aside>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/SystemStatus.tsx",
      content: `"use client";
import { Wifi, AlertTriangle, Zap, Activity } from "lucide-react";

const statusCards = [
  { label: "Devices Online", value: "24/28", icon: Wifi, color: "text-green-400", bgColor: "bg-green-500/10" },
  { label: "Alerts Active", value: "3", icon: AlertTriangle, color: "text-amber-400", bgColor: "bg-amber-500/10" },
  { label: "Data Points Today", value: "1.2M", icon: Zap, color: "text-blue-400", bgColor: "bg-blue-500/10" },
  { label: "Uptime", value: "99.7%", icon: Activity, color: "text-purple-400", bgColor: "bg-purple-500/10" },
];

export function SystemStatus() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {statusCards.map((card, i) => {
        const Icon = card.icon;
        return (
          <div key={i} className="p-5 rounded-xl bg-[#141414] border border-white/10">
            <div className="flex items-center justify-between mb-3">
              <div className={\`p-2 rounded-lg \${card.bgColor}\`}>
                <Icon className={\`w-4 h-4 \${card.color}\`} />
              </div>
            </div>
            <p className="text-2xl font-bold">{card.value}</p>
            <p className="text-xs text-gray-500 mt-1">{card.label}</p>
          </div>
        );
      })}
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/DeviceCard.tsx",
      content: `"use client";
import { Wifi, WifiOff, AlertTriangle, Battery, BatteryLow, Thermometer, Radio, Cpu } from "lucide-react";
import { GaugeChart } from "./GaugeChart";

interface Device {
  id: number;
  name: string;
  type: "sensor" | "camera" | "thermostat" | "gateway";
  status: "online" | "offline" | "warning";
  lastReading: string;
  battery: number;
  value: number;
  unit: string;
  sparkline: number[];
}

interface DeviceCardProps {
  device: Device;
}

const typeIcons: Record<string, typeof Cpu> = {
  sensor: Radio,
  camera: Cpu,
  thermostat: Thermometer,
  gateway: Wifi,
};

const statusColors: Record<string, { dot: string; bg: string; text: string }> = {
  online: { dot: "bg-green-400", bg: "bg-green-500/10", text: "text-green-400" },
  offline: { dot: "bg-gray-500", bg: "bg-gray-500/10", text: "text-gray-400" },
  warning: { dot: "bg-amber-400", bg: "bg-amber-500/10", text: "text-amber-400" },
};

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 120;
  const h = 32;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return \`\${x},\${y}\`;
  }).join(" ");

  return (
    <svg width={w} height={h} viewBox={\`0 0 \${w} \${h}\`} className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DeviceCard({ device }: DeviceCardProps) {
  const StatusIcon = device.status === "offline" ? WifiOff : device.status === "warning" ? AlertTriangle : Wifi;
  const TypeIcon = typeIcons[device.type] ?? Cpu;
  const colors = statusColors[device.status];
  const sparkColor = device.status === "online" ? "#22c55e" : device.status === "warning" ? "#f59e0b" : "#6b7280";

  return (
    <div className="rounded-xl bg-[#141414] border border-white/10 p-4 hover:border-white/20 transition">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={\`p-1.5 rounded-lg \${colors.bg}\`}>
            <TypeIcon className={\`w-3.5 h-3.5 \${colors.text}\`} />
          </div>
          <div>
            <p className="text-sm font-medium">{device.name}</p>
            <p className="text-[10px] text-gray-500 capitalize">{device.type}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={\`w-2 h-2 rounded-full \${colors.dot} \${device.status === "online" ? "animate-pulse" : ""}\`} />
          <span className={\`text-[10px] capitalize \${colors.text}\`}>{device.status}</span>
        </div>
      </div>

      {/* Value + sparkline */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <p className="text-2xl font-bold">{device.value}<span className="text-sm text-gray-500 ml-1">{device.unit}</span></p>
          <p className="text-[10px] text-gray-500">{device.lastReading}</p>
        </div>
        <Sparkline data={device.sparkline} color={sparkColor} />
      </div>

      {/* Battery */}
      <div className="flex items-center gap-2 pt-3 border-t border-white/5">
        {device.battery < 20 ? (
          <BatteryLow className="w-3.5 h-3.5 text-red-400" />
        ) : (
          <Battery className="w-3.5 h-3.5 text-gray-500" />
        )}
        <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className={\`h-full rounded-full transition-all \${
              device.battery < 20 ? "bg-red-500" : device.battery < 50 ? "bg-amber-500" : "bg-green-500"
            }\`}
            style={{ width: \`\${device.battery}%\` }}
          />
        </div>
        <span className="text-[10px] text-gray-500">{device.battery}%</span>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/GaugeChart.tsx",
      content: `"use client";

interface GaugeChartProps {
  value: number;
  min: number;
  max: number;
  unit: string;
  label: string;
  color?: string;
}

export function GaugeChart({ value, min, max, unit, label, color = "#22c55e" }: GaugeChartProps) {
  const range = max - min;
  const pct = Math.min(Math.max((value - min) / range, 0), 1);
  const radius = 50;
  const circumference = Math.PI * radius; // semicircle
  const offset = circumference - pct * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg width="140" height="80" viewBox="0 0 140 80">
        {/* Background arc */}
        <path
          d="M 15 75 A 55 55 0 0 1 125 75"
          fill="none"
          stroke="rgba(255,255,255,0.05)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Value arc */}
        <path
          d="M 15 75 A 55 55 0 0 1 125 75"
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={\`\${pct * 172} 172\`}
          className="transition-all duration-700"
        />
        {/* Min label */}
        <text x="15" y="78" fill="#6b7280" fontSize="8" textAnchor="middle">{min}</text>
        {/* Max label */}
        <text x="125" y="78" fill="#6b7280" fontSize="8" textAnchor="middle">{max}</text>
      </svg>
      <div className="-mt-8 text-center">
        <p className="text-xl font-bold">{value}<span className="text-xs text-gray-500 ml-0.5">{unit}</span></p>
        <p className="text-[10px] text-gray-500">{label}</p>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/DeviceGrid.tsx",
      content: `"use client";
import { DeviceCard } from "./DeviceCard";

const devices = [
  { id: 1, name: "Temp Sensor A1", type: "sensor" as const, status: "online" as const, lastReading: "Updated 5s ago", battery: 82, value: 23.4, unit: "\u00b0C", sparkline: [22, 22.5, 23, 22.8, 23.1, 23.4, 23.2, 23.6, 23.4] },
  { id: 2, name: "Security Cam 01", type: "camera" as const, status: "online" as const, lastReading: "Streaming", battery: 100, value: 30, unit: "fps", sparkline: [30, 29, 30, 30, 28, 30, 29, 30, 30] },
  { id: 3, name: "Living Room", type: "thermostat" as const, status: "online" as const, lastReading: "Updated 10s ago", battery: 67, value: 21.0, unit: "\u00b0C", sparkline: [20.5, 20.8, 21, 21.2, 21, 20.9, 21, 21.1, 21] },
  { id: 4, name: "Gateway Hub", type: "gateway" as const, status: "online" as const, lastReading: "32 devices", battery: 100, value: 99.9, unit: "%", sparkline: [99.8, 99.9, 99.9, 100, 99.7, 99.9, 99.8, 99.9, 99.9] },
  { id: 5, name: "Humidity B2", type: "sensor" as const, status: "warning" as const, lastReading: "High reading", battery: 15, value: 78, unit: "%", sparkline: [60, 62, 65, 68, 70, 72, 75, 77, 78] },
  { id: 6, name: "Pressure Sensor", type: "sensor" as const, status: "online" as const, lastReading: "Updated 3s ago", battery: 91, value: 1013, unit: "hPa", sparkline: [1012, 1012.5, 1013, 1012.8, 1013.2, 1013, 1013.1, 1012.9, 1013] },
  { id: 7, name: "Parking Cam 03", type: "camera" as const, status: "offline" as const, lastReading: "Lost signal 2h ago", battery: 0, value: 0, unit: "fps", sparkline: [30, 30, 28, 25, 15, 5, 0, 0, 0] },
  { id: 8, name: "Outdoor Temp", type: "sensor" as const, status: "online" as const, lastReading: "Updated 8s ago", battery: 45, value: 14.2, unit: "\u00b0C", sparkline: [15, 14.8, 14.5, 14.3, 14.2, 14.1, 14.2, 14.3, 14.2] },
];

export function DeviceGrid() {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Devices</h2>
        <span className="text-xs text-gray-500">{devices.filter((d) => d.status === "online").length}/{devices.length} online</span>
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {devices.map((device) => (
          <DeviceCard key={device.id} device={device} />
        ))}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/AlertsPanel.tsx",
      content: `"use client";
import { AlertTriangle, Bell } from "lucide-react";

interface Alert {
  id: number;
  severity: "critical" | "warning" | "info";
  device: string;
  description: string;
  timestamp: string;
}

const alerts: Alert[] = [
  { id: 1, severity: "critical", device: "Humidity B2", description: "Humidity exceeded 75% threshold. Immediate action required.", timestamp: "2 min ago" },
  { id: 2, severity: "critical", device: "Parking Cam 03", description: "Device offline — no response for 2 hours.", timestamp: "2h ago" },
  { id: 3, severity: "warning", device: "Humidity B2", description: "Battery level critically low at 15%.", timestamp: "15 min ago" },
  { id: 4, severity: "warning", device: "Outdoor Temp", description: "Battery below 50%. Schedule replacement.", timestamp: "1h ago" },
  { id: 5, severity: "info", device: "Gateway Hub", description: "Firmware update v2.4.1 available for download.", timestamp: "3h ago" },
  { id: 6, severity: "info", device: "System", description: "Daily backup completed successfully.", timestamp: "6h ago" },
];

const severityConfig: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  critical: { bg: "bg-red-500/10", border: "border-red-500/20", text: "text-red-400", icon: "text-red-400" },
  warning: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-400", icon: "text-amber-400" },
  info: { bg: "bg-blue-500/10", border: "border-blue-500/20", text: "text-blue-400", icon: "text-blue-400" },
};

export function AlertsPanel() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/10 overflow-hidden">
      <div className="p-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-semibold">Alerts</span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-[10px] font-medium">
          {alerts.filter((a) => a.severity === "critical").length} critical
        </span>
      </div>
      <div className="divide-y divide-white/5 max-h-[600px] overflow-y-auto">
        {alerts.map((alert) => {
          const config = severityConfig[alert.severity];
          return (
            <div key={alert.id} className="p-4 hover:bg-white/5 transition">
              <div className="flex items-start gap-3">
                <div className={\`p-1.5 rounded-lg \${config.bg} flex-shrink-0 mt-0.5\`}>
                  <AlertTriangle className={\`w-3.5 h-3.5 \${config.icon}\`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={\`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase \${config.bg} \${config.text}\`}>
                      {alert.severity}
                    </span>
                    <span className="text-xs text-gray-500">{alert.timestamp}</span>
                  </div>
                  <p className="text-xs font-medium text-gray-300">{alert.device}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{alert.description}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    {
      path: "src/components/SensorTimeline.tsx",
      content: `"use client";

const hours = Array.from({ length: 24 }, (_, i) => \`\${i.toString().padStart(2, "0")}:00\`);

// Simulated temperature data over 24 hours
const tempData = [
  14.2, 13.8, 13.5, 13.2, 12.9, 12.7, 13.0, 14.1, 15.5, 17.2, 19.0, 20.5,
  21.8, 22.4, 23.0, 23.4, 23.1, 22.3, 21.0, 19.5, 18.0, 16.8, 15.5, 14.8,
];

// Simulated humidity data
const humidData = [
  65, 66, 68, 70, 72, 73, 71, 68, 64, 60, 56, 52,
  50, 48, 47, 48, 50, 54, 58, 62, 65, 67, 68, 66,
];

function LineChart({
  data,
  color,
  label,
  unit,
  minY,
  maxY,
}: {
  data: number[];
  color: string;
  label: string;
  unit: string;
  minY: number;
  maxY: number;
}) {
  const w = 700;
  const h = 140;
  const pad = { top: 10, right: 10, bottom: 24, left: 40 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const range = maxY - minY;

  const points = data.map((v, i) => {
    const x = pad.left + (i / (data.length - 1)) * cw;
    const y = pad.top + ch - ((v - minY) / range) * ch;
    return { x, y };
  });

  const pathD = points.map((p, i) => \`\${i === 0 ? "M" : "L"}\${p.x},\${p.y}\`).join(" ");
  const areaD = pathD + \` L\${points[points.length - 1].x},\${pad.top + ch} L\${points[0].x},\${pad.top + ch} Z\`;

  const yTicks = 5;
  const yLabels = Array.from({ length: yTicks }, (_, i) => minY + (range / (yTicks - 1)) * i);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-xs text-gray-400">{label}</span>
        <span className="text-xs font-semibold ml-auto">{data[data.length - 1]}{unit}</span>
      </div>
      <svg width="100%" viewBox={\`0 0 \${w} \${h}\`} className="overflow-visible">
        {/* Grid lines */}
        {yLabels.map((v, i) => {
          const y = pad.top + ch - ((v - minY) / range) * ch;
          return (
            <g key={i}>
              <line x1={pad.left} x2={w - pad.right} y1={y} y2={y} stroke="rgba(255,255,255,0.05)" />
              <text x={pad.left - 6} y={y + 3} fill="#6b7280" fontSize="8" textAnchor="end">{Math.round(v)}</text>
            </g>
          );
        })}

        {/* X labels (every 4 hours) */}
        {hours.filter((_, i) => i % 4 === 0).map((label, i) => {
          const x = pad.left + ((i * 4) / (data.length - 1)) * cw;
          return <text key={i} x={x} y={h - 4} fill="#6b7280" fontSize="8" textAnchor="middle">{label}</text>;
        })}

        {/* Area fill */}
        <path d={areaD} fill={color} opacity="0.08" />

        {/* Line */}
        <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {/* Current value dot */}
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="4" fill={color} />
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="7" fill={color} opacity="0.2" />
      </svg>
    </div>
  );
}

export function SensorTimeline() {
  return (
    <div className="rounded-xl bg-[#141414] border border-white/10 p-6">
      <h2 className="text-lg font-semibold mb-6">Sensor Readings — 24h</h2>
      <div className="space-y-8">
        <LineChart data={tempData} color="#22c55e" label="Temperature" unit="\u00b0C" minY={10} maxY={28} />
        <LineChart data={humidData} color="#3b82f6" label="Humidity" unit="%" minY={40} maxY={80} />
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
  ];
}
