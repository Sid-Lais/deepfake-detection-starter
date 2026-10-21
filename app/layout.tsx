import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const body = Inter({ variable: "--font-body-face", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Velma Deepfake Detection Starter",
  description: "Upload or record a voice clip and see what Modulate's Velma Deepfake Detection makes of it.",
};

const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} h-full antialiased`}>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
