import type { AsyncStorageStatic } from '@react-native-async-storage/async-storage';

declare module '@react-native-async-storage/async-storage' {
  interface AsyncStorageStatic {
    __store?: Record<string, string | null>;
  }
}

export {};
