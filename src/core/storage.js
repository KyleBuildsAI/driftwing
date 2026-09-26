
// ---- Persistent storage (localStorage can throw in private modes) -------------
// read() returns the fallback when storage is blocked or the stored JSON is
// corrupt; write() reports failure so callers can tell the player once.
export const storage = {
  read(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  },
  write(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  },
};
