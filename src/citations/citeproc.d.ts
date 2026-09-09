/**
 * Minimal type declarations for the `citeproc` package, which ships none.
 *
 * Only the surface this project actually uses is declared. Widen it
 * deliberately rather than reaching for `any` at a call site.
 */
declare module 'citeproc' {
  /** A CSL-JSON item. Field names are CSL's, e.g. `container-title`. */
  export interface CslJsonItem {
    id: string;
    type: string;
    [field: string]: unknown;
  }

  /** One entry in a citation cluster. */
  export interface CitationItem {
    id: string;
    locator?: string;
    label?: string;
    prefix?: string;
    suffix?: string;
    'suppress-author'?: boolean;
    'author-only'?: boolean;
  }

  export interface Sys {
    retrieveLocale(language: string): string;
    retrieveItem(id: string): CslJsonItem;
  }

  export interface BibliographyMeta {
    entry_ids: string[][];
    bibstart: string;
    bibend: string;
    hangingindent: number | false;
    'second-field-align': string | false;
    maxoffset: number;
    entryspacing: number;
    linespacing: number;
  }

  export class Engine {
    constructor(sys: Sys, style: string, lang?: string, forceLang?: boolean);
    updateItems(ids: string[]): void;
    setOutputFormat(format: 'html' | 'text' | 'rtf'): void;
    /** Returns `false` when no entries could be produced. */
    makeBibliography(): [BibliographyMeta, string[]] | false;
    /** Renders one citation cluster, e.g. the text of a footnote. */
    makeCitationCluster(items: CitationItem[]): string;
    opt: { development_extensions: Record<string, boolean> };
  }

  /**
   * `citeproc` is CommonJS and builds its exports dynamically, so Node's
   * named-export detection cannot see `Engine`. It must be imported as the
   * default export and destructured; see `render.ts`.
   */
  interface CiteprocModule {
    Engine: typeof Engine;
    PROCESSOR_VERSION: string;
  }

  const citeproc: CiteprocModule;
  export default citeproc;
}
