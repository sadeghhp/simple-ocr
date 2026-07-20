import './globals.css';

export const metadata = {
  title: 'Simple OCR',
  description:
    'A private, browser-only OCR workspace. Files and extracted text stay in your browser.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
