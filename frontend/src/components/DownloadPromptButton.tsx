import { FileDown } from 'lucide-react';
import { downloadAppPrompt } from '../appPrompt';

/**
 * "Descargar prompt": instrucciones para un asistente de IA que dejan una app lista para AppHub.
 * Con `route` (y `appName`) el prompt ya trae la ruta de publicación de esa app.
 */
export default function DownloadPromptButton({ appName, route, small }: { appName?: string; route?: string | null; small?: boolean }) {
  return (
    <button className={`btn outline${small ? ' sm' : ''}`} onClick={() => downloadAppPrompt({ appName, route })}
      title="Instrucciones para pedirle a un asistente de IA (Claude, Copilot, ChatGPT…) que deje la app lista para subir a AppHub">
      <FileDown size={small ? 13 : 15} />Descargar prompt
    </button>
  );
}
