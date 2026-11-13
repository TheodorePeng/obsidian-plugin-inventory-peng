export class App {}
export class TFile {
  path: string; stat = { size: 1, mtime: 1 }; extension: string;
  constructor(path: string) { this.path = path; this.extension = path.split('.').pop() ?? ''; }
}
export class TFolder { path: string; constructor(path: string) { this.path = path; } }
export class Plugin { app: any; constructor(app: any) { this.app = app; } }
export class AbstractInputSuggest {}
export class FileView {}
export class MarkdownView {}
export class Modal {}
export class Notice {}
export class PluginSettingTab {}
export class Setting {}
export const getLanguage = () => 'en';
export const requestUrl = async () => { throw new Error('offline test'); };
