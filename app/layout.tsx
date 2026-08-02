import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RosterPilot — Agentic Army Builder",
  description:
    "Build, inspect, modify, validate, explain, and export deterministic Warhammer 40,000 army rosters from official-first rules data.",
  openGraph: {
    title: "RosterPilot — Agentic Army Builder",
    description: "Build the army you mean to play.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "RosterPilot army-building command desk",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "RosterPilot — Agentic Army Builder",
    description: "Build the army you mean to play.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
