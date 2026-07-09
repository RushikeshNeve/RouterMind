import { links } from "./data";

const footerLinks = [
  { label: "GitHub", href: links.github },
  { label: "Dashboard", href: links.dashboard },
  { label: "Documentation", href: links.docs },
  { label: "SDK", href: links.sdk },
  { label: "CLI", href: links.cli },
];

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white px-6 py-10 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <img
              src="/routemind-icon.svg"
              alt=""
              aria-hidden="true"
              className="h-9 w-9 rounded-lg object-contain"
            />
            <span className="text-sm font-semibold text-slate-950">RouteMind</span>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Built by{" "}
            <a className="font-medium text-slate-700 hover:text-blue-600" href={links.authorGithub}>
              Rushikesh Neve
            </a>
          </p>
          <p className="mt-1 text-sm text-slate-500">
            <a className="hover:text-blue-600" href={links.authorGithub}>
              GitHub
            </a>
            <span className="mx-2">/</span>
            <a className="hover:text-blue-600" href={links.linkedIn}>
              LinkedIn
            </a>
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-3">
          {footerLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm font-medium text-slate-600 transition hover:text-blue-600"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
