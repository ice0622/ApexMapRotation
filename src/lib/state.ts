// state/ ディレクトリ（前回値などの永続データ）の読み書き。
// GitHub Actions では変化があったときだけこのファイルが commit & push される。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const LAST_MAP_PATH = fileURLToPath(new URL('../../state/last_map.json', import.meta.url));

export type LastMapState = {
  map: string;
  updatedAt: string;
};

// 前回の現在マップ { map, updatedAt } を返す。未記録・読取不能なら null（初回扱い）。
export async function readLastMap(): Promise<LastMapState | null> {
  try {
    const parsed: Partial<LastMapState> | null = JSON.parse(
      await readFile(LAST_MAP_PATH, 'utf8'),
    );
    // map が非空文字列のときだけ「前回値あり」とみなす。
    if (parsed && typeof parsed.map === 'string' && parsed.map.length > 0) {
      return parsed as LastMapState;
    }
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null; // 初回実行
    console.warn(`state ファイルを読めませんでした（${e.message}）。初回扱いにします。`);
    return null; // 壊れたファイルは初回扱いで再シード（クラッシュさせない）
  }
}

export async function writeLastMap(map: string): Promise<void> {
  const state: LastMapState = { map, updatedAt: new Date().toISOString() };
  await mkdir(dirname(LAST_MAP_PATH), { recursive: true });
  await writeFile(LAST_MAP_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
