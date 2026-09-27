import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  subsets: ["latin", "cyrillic"],
  variable: "--font-montserrat",
  display: "swap",
});

export const metadata: Metadata = {
  title: "VK Tech · Template presentation MVP",
  description: "An isolated Lazyum hackathon MVP for editable template-driven decks.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={montserrat.variable}>
      <body>{children}</body>
    </html>
  );
}
