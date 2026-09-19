import './globals.css';
import type { ReactNode } from 'react';
export const metadata = { title: 'Axiom ERP', description: 'Enterprise ERP platform' };
export default function RootLayout({children}:{children:ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
