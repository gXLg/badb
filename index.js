const fs = require("fs");

const __TYPES  = ["string", "uint32", "int32", "uint16", "int16", "uint8", "int8"];
const __LENGTHS = {
  "uint32": 4, "int32": 4,
  "uint16": 2, "int16": 2,
  "uint8": 1, "int8": 1
};
const __FUNC = {
  "uint32": ["writeUint32LE", "readUint32LE"], "int32": ["writeInt32LE", "readInt32LE"],
  "uint16": ["writeUint16LE", "readUint16LE"], "int16": ["writeInt16LE", "readInt16LE"],
  "uint8": ["writeUint8", "readUint8"], "int8": ["writeInt8", "readInt8"]
}

function TYPE_OF_ID(id) {
  return __TYPES[id];
}
function ID_OF_TYPE(type) {
  return __TYPES.indexOf(type.toLowerCase());
}
function IS_FIXED_LENGTH(type) {
  return type.toLowerCase() in __LENGTHS;
}
function LENGTH_OF_TYPE(type) {
  return __LENGTHS[type.toLowerCase()];
}
function PROVE_VALUE(type, maxLength, value) {
  if (type == "string") {
    if (typeof value != "string") return false;
    return (Buffer.from(value).byteLength <= maxLength - 2);
  }
  const val = parseInt(value);
  if (isNaN(val)) return false;
  if (type.startsWith("u")) {
    return 0 <= val && val < 2 ** (8 * maxLength);
  } else {
    return - (2 ** (8 * maxLength - 1)) <= val && val < 2 ** (8 * maxLength - 1);
  }
}

function WRITE(buffer, type, value, offset) {
  if (type == "string") {
    const byteLength = Buffer.from(value).byteLength;
    buffer.writeUint16LE(byteLength, offset);
    buffer.utf8Write(value, offset + 2);
  } else {
    buffer[__FUNC[type][0]](value, offset);
  }
}

function READ(buffer, type, offset) {
  if (type == "string") {
    const byteLength = buffer.readUint16LE(offset);
    return buffer.utf8Slice(offset + 2, offset + 2 + byteLength);
  } else {
    return buffer[__FUNC[type][1]](offset);
  }
}

function PARSE_VALUE(value, isKey) {
  if (!("name" in value) || typeof value.name != "string") {
    throw new Error("The value must have a 'name' which is a string");
  }
  const name = value.name;

  if (isKey && "default" in value) {
    throw new Error("The key can't have a default value");
  }

  let type;
  if (!("type" in value)) {
    type = "string";
  } else {
    if (typeof value.type != "string" || ID_OF_TYPE(value.type) == -1) {
      throw new Error("Unsupported type '" + value.type + "' for value '" + name + "'");
    }
    type = value.type.toLowerCase();
  }

  if ("maxLength" in value && IS_FIXED_LENGTH(type)) {
    throw new Error("Explicit 'maxLength' in value '" + name + "' for a fixed length type '" + type + "'");
  }

  if (!IS_FIXED_LENGTH(type) && !("maxLength" in value) && !("default" in value)) {
    throw new Error("No 'maxLength' or 'default' in value '" + name + "' for a type without a fixed length");
  }

  if ("maxLength" in value && typeof value.maxLength != "number") {
    throw new Error("The 'maxLength' of a value must be a number, in value '" + name + "'");
  }

  let defaultValue;
  if ("default" in value) {
    const expectedType = type == "string" ? "string" : "number";
    if (typeof value.default != expectedType) {
      throw new Error("The default value '" + value.default + "' does not match the given type '" + type + "', in value '" + name + "'");
    }
    defaultValue = value.default;
  } else {
    if (type == "string") defaultValue = "";
    else defaultValue = 0;
  }

  let maxLength;
  if (IS_FIXED_LENGTH(type)) {
    maxLength = LENGTH_OF_TYPE(type);
  } else {
    if ("maxLength" in value) {
      maxLength = value.maxLength;
    } else {
      maxLength = Buffer.from(defaultValue).byteLength + 2;
    }
  }

  if (!IS_FIXED_LENGTH(type)) {
    maxLength += 2; // len of field
  }

  if (!PROVE_VALUE(type, maxLength, defaultValue)) {
    throw new Error("The default value of the value '" + name + "' does not fit in 'maxLength'");
  }

  return { name, type, defaultValue, maxLength };
}

class EntryControl {
  constructor(exists) {
    this.__exists = exists;
    this.__removed = false;
    this.__confirmed = false;
  }

  remove() {
    this.__removed = true;
    return this.__exists;
  }

  removed() {
    return this.__removed;
  }

  confirm() {
    this.__confirmed = true;
    return !this.__exists;
  }

  confirmed() {
    return this.__confirmed;
  }

  exists() {
    return this.__exists;
  }
}

class BadTable {
  constructor(path, options) {
    // options
    // key: name
    // values:
    //  name, type, default, max length (string length)
    // types:
    //   string (requires maxLength),
    //   (u)int32 (maxLength = 4), (u)int16 (maxLength = 2), (u)int8 (maxLength = 1)
    //
    // default values:
    //   default is equal to empty string or 0
    //   type is by default a string (requiring maxLength)
    //   if default is set for type=string, the default maxLength is set to its' length + 2
    //
    // example:
    /*
      {
        "key": "id",
        "values": [
          { "name": "id", "maxLength": 10 },
          { "name": "login", "maxLength": 32 },
          { "name": "gamesPlayed", "type": "uint32" }
        ]
      }
    */
    // Sections of database:
    // [len] Header, default row, [len] Values
    // len: Uint32 (little endian)

    if (options == null) {
      throw new Error("Options must be passed to the constructor");
    }

    const key = options.key;
    if (key == null) {
      throw new Error("'key' must be present in the database");
    }
    if (typeof key != "string") {
      throw new Error("'key' must be a string");
    }

    const values = options.values;
    if (values == null) {
      throw new Error("'values' must be present in the database");
    }
    if (values.constructor != [].constructor) {
      throw new Error("'values' must be an array");
    }

    const lru_index_max = options.indexCache ?? 1024;
    if (typeof lru_index_max != "number" || lru_index_max < 0) {
      throw new Error("'indexCache' must be a positive number");
    }
    const lru_data_max = options.indexData ?? 64;
    if (typeof lru_data_max != "number" || lru_data_max < 0) {
      throw new Error("'indexData' must be a positive number");
    }

    let namesLength = 2;
    let headerLength = 4;
    let defaultsLength = 0;
    let keyLength;

    const dnames = new Set();
    const newValues = [];
    for (const value of values) {
      if (value == null || value.constructor != {}.constructor) {
        throw new Error("The value must be an object");
      }
      const name = value.name;
      if (dnames.has(name)) {
        throw new Error("The name '" + name + "' is a duplicate");
      }
      dnames.add(name);
      namesLength += Buffer.from(name).byteLength + 1; // NULL byte ending

      const isKey = name == key;
      const v = PARSE_VALUE(value, isKey);
      if (isKey) {
        newValues.unshift({ name, ...v });
        keyLength = v.maxLength;
      } else {
        newValues.push({ name, ...v });
        defaultsLength += v.maxLength;
      }
      headerLength += 1 + 2; // type, maxLength
    }

    const rowLength = keyLength + defaultsLength;

    const names = Buffer.alloc(namesLength);
    let namesOffset = 2; // size of names
    const header = Buffer.alloc(headerLength);
    let headerOffset = 4; // size of header
    const defaults = Buffer.alloc(defaultsLength);
    let defaultsOffset = 0;
    const entries = {};
    const keyData = { "name": key };

    names.writeUint16LE(namesLength - 2, 0);
    header.writeUint32LE(headerLength - 4, 0);
    for (const { name, type, defaultValue, maxLength } of newValues) {
      namesOffset += names.utf8Write(name, namesOffset);
      names.writeUint8(0, namesOffset);
      namesOffset += 1;

      header.writeUint8(ID_OF_TYPE(type), headerOffset);
      headerOffset += 1;
      header.writeUint16LE(maxLength, headerOffset);
      headerOffset += 2;

      if (name == key) {
        keyData.type = type;
        keyData.maxLength = maxLength;
      } else {
        WRITE(defaults, type, defaultValue, defaultsOffset);
        entries[name] = { type, maxLength, defaultValue, "offset": defaultsOffset + keyLength };
        defaultsOffset += maxLength;
      }
    }

    const magic = Buffer.from([0xB, 0xA, 0xD, 0xB]);

    const namesFOffset    = magic.byteLength;
    const headerFOffset   = magic.byteLength + namesLength;
    const defaultsFOffset = magic.byteLength + namesLength + headerLength;
    const dataFOffset     = magic.byteLength + namesLength + headerLength + defaultsLength + 4; // data size

    let fd;
    let size = 0;
    if (fs.existsSync(path)) {
      fd = fs.openSync(path, "r+");

      const magicOld = Buffer.alloc(magic.byteLength);
      fs.readSync(fd, magicOld, 0, magic.byteLength, 0);
      if (!magic.equals(magicOld)) {
        fs.closeSync(fd);
        throw new Error("The existing file is not a Bad Database");
      }

      const namesOld = Buffer.alloc(namesLength);
      fs.readSync(fd, namesOld, 0, namesLength, namesFOffset);
      if (!names.equals(namesOld)) {
        fs.closeSync(fd);
        throw new Error("The names do not match");
      }

      const headerOld = Buffer.alloc(headerLength);
      fs.readSync(fd, headerOld, 0, headerLength, headerFOffset);
      if (!header.equals(headerOld)) {
        fs.closeSync(fd);
        throw new Error("The header does not match");
      }

      const defaultsOld = Buffer.alloc(defaultsLength);
      fs.readSync(fd, defaultsOld, 0, defaultsLength, defaultsFOffset);
      if (!defaults.equals(defaultsOld)) {
        fs.closeSync(fd);
        throw new Error("The default values do not match");
      }

      const sizeBuffer = Buffer.alloc(4);
      fs.readSync(fd, sizeBuffer, 0, 4, dataFOffset - 4);
      size = sizeBuffer.readUint32LE(0);

    } else {
      fd = fs.openSync(path, "w+");

      fs.writeSync(fd, magic, 0, magic.bytesLength, 0)
      fs.writeSync(fd, names, 0, namesLength, namesFOffset);
      fs.writeSync(fd, header, 0, headerLength, headerFOffset);
      fs.writeSync(fd, defaults, 0, defaultsLength, defaultsFOffset);
      fs.writeSync(fd, Buffer.alloc(4), 0, 4, dataFOffset - 4);
    }

    const lru_index = [];

    function saveSize() {
      const sizeBuffer = Buffer.alloc(4);
      sizeBuffer.writeUint32LE(size);
      fs.writeSync(fd, sizeBuffer, 0, 4, dataFOffset - 4);
    }

    function find(key, create) {
      for (let i = 0; i < lru_index.length; i ++) {
        const { "key": lkey, idx } = lru_index[i];
        if (lkey == key) {
          lru_index.unshift(lru_index.splice(i, 1)[0]);
          return idx;
        }
      }

      const keyBuffer = Buffer.alloc(keyData.maxLength);
      WRITE(keyBuffer, keyData.type, key, 0);
      const compareBuffer = Buffer.alloc(keyData.maxLength);
      for (let i = 0; i < size; i ++) {
        fs.readSync(fd, compareBuffer, 0, keyData.maxLength, dataFOffset + i * rowLength);
        if (keyBuffer.equals(compareBuffer)) {
          lru_index.unshift({ key, "idx": i });
          if (lru_index.length > lru_index_max) lru_index.pop();
          return i;
        }
      }
      if (!create) return -1;

      size += 1;
      saveSize();
      return size - 1;
    }

    const lru_data = [];

    function load(key) {
      for (let i = 0; i < lru_data.length; i ++) {
        const { "key": lkey, data } = lru_data[i];
        if (lkey == key) {
          if (i != 0) lru_data.unshift(lru_data.splice(i, 1)[0]);
          const obj = { ...data };
          return { obj, "exists": true };
        }
      }

      const idx = find(key);
      if (idx == -1) {
        const obj = { };
        for (const name in entries) {
          const { defaultValue } = entries[name];
          obj[name] = defaultValue;
        }
        return { obj, "exists": false };
      }
      const rowBuffer = Buffer.alloc(rowLength);
      fs.readSync(fd, rowBuffer, 0, rowLength, dataFOffset + idx * rowLength);
      const obj = { };
      for (const name in entries) {
        const { type, offset } = entries[name];
        obj[name] = READ(rowBuffer, type, offset);
      }

      lru_data.unshift({ key, "data": { ...obj }});
      if (lru_data.length > lru_data_max) {
        const { "key": lkey, data } = lru_data.pop();
        save(lkey, data);
      }

      return { obj, "exists": true };
    };

    function save(key, obj) {
      const rowBuffer = Buffer.alloc(rowLength);
      WRITE(rowBuffer, keyData.type, key, 0);
      for (const name in entries) {
        const { type, defaultValue, offset, maxLength } = entries[name];
        WRITE(rowBuffer, type, obj[name] ?? defaultValue, offset);
      }
      const idx = find(key, true);
      fs.writeSync(fd, rowBuffer, 0, rowLength, dataFOffset + idx * rowLength);
    }

    function write(key, obj) {
      for (let i = 0; i < lru_data.length; i ++) {
        const { "key": lkey } = lru_data[i];
        if (lkey == key) {
          lru_data.splice(i, 1);
          lru_data.unshift({ key, "data": { ...obj }});
          return;
        }
      }
      lru_data.unshift({ key, "data": { ...obj }});
      if (lru_data.length > lru_data_max) {
        const { "key": lkey, data } = lru_data.pop();
        save(lkey, data);
      }
    }

    function remove(key) {
      for (let i = 0; i < lru_data.length; i ++) {
        const { "key": lkey } = lru_data[i];
        if (lkey == key) {
          lru_data.splice(i, 1);
          break;
        }
      }
      for (let i = 0; i < lru_index.length; i ++) {
        const { "key": lkey } = lru_index[i];
        if (lkey == key) {
          lru_index.splice(i, 1);
          break;
        }
      }

      const idx = find(key);
      if (idx == -1) return;

      if (size == 1) {
        size = 0;
        saveSize();
        fs.ftruncateSync(fd, dataFOffset);
        return;
      }

      const lastOffset = dataFOffset + (size - 1) * rowLength;
      const lastRow = Buffer.alloc(rowLength);
      fs.readSync(fd, lastRow, 0, rowLength, lastOffset);
      fs.writeSync(fd, lastRow, 0, rowLength, dataFOffset + idx * rowLength);
      fs.ftruncateSync(fd, lastOffset);
      size -= 1;
      saveSize();
    }

    this.size = () => {
      return size;
    };

    let closed = false;
    this.close = () => {
      if (closed) return;
      closed = true;
      for (const { key, data } of lru_data) {
        save(key, data);
      }
      fs.closeSync(fd);
    }

    process.once("exit", () => { this.close(); });

    let fsLock = null;
    const keyLocks = {};

    async function executeFS(callback) {
      const lock = fsLock ?? null;
      const newLock = new Promise(async res => {
          await lock;
          res(callback());
      });
      fsLock = newLock;
      return newLock;
    }

    return new Proxy(this, {
      "get": (target, rkey) => {
        if (rkey in target) return target[rkey];
        if (!PROVE_VALUE(keyData.type, keyData.maxLength, rkey)) {
          throw new Error("The value '" + rkey + "' does not fit into the key");
        }
        const key = keyData.type == "string" ? rkey.toString() : parseInt(rkey);
        return async callback => {
          const lock = keyLocks[key] ?? null;
          const newLock = new Promise(async (res, rej) => {
            try { await lock; } catch { }

            try {
              const { obj, exists } = await executeFS(() => load(key));
              const old = { ...obj };
              const control = new EntryControl(exists);
              const ret = await callback(obj, control);

              if (control.removed()) {
                if (exists) await executeFS(() => remove(key));
                res(ret);
                return;
              }

              let same = true;
              for (const name in entries) {
                const { type, defualtValue, maxLength } = entries[name];
                const value = obj[name] ?? defaultValue;
                if (!PROVE_VALUE(type, maxLength, value)) {
                  throw new Error("The value '" + value + "' does not fit into the field '" + name + "'");
                }
                if (value != old[name]) {
                  same = false;
                }
              }
              if (!same || (!exists && control.confirmed())) await executeFS(() => write(key, obj));
              res(ret);

            } catch (error) { rej(error); }
          });
          keyLocks[key] = newLock;
          return newLock;
        };
      }
    });

  }
}

class BadSet {
  constructor(path, options) {
    // options
    // similar to BadTable, but only one single value
    // type or maxLength is required

    if (options == null) {
      throw new Error("Options must be passed to the constructor");
    }
    if (!("type" in options) && !("maxLength" in options)) {
      throw new Error("At least on of 'type' or 'maxLength' is required for a set");
    }

    const v = { };
    if ("type" in options) v.type = options.type;
    if ("maxLength" in options) v.maxLength = options.maxLength;

    const table = new BadTable(path, {
      "key": "value",
      "values": [{ "name": "value", ...v }],
      "cacheIndex": options.cacheIndex,
      "cacheData": options.cacheData
    });

    this.has = async key => {
      return await table[key]((e, c) => c.exists());
    };

    this.add = async key => {
      return await table[key]((e, c) => c.confirm());
    };

    this.remove = async key => {
      return await table[key]((e, c) => c.remove());
    }

    this.size = () => {
      return table.size();
    };

    this.close = () => table.close();
  }
}

module.exports = { BadTable, BadSet };
