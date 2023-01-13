// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

require('dotenv').config();
const http = require("http");
const fs = require("fs");
const child_process = require("child_process");
const net = require("net");
const crypto = require("crypto");
const path = require("path");

const PORT = parseInt(process.env.PORT || 8080, 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || "./data";
const DDNS_ZONE = process.env.DDNS_ZONE || 'example.com.';
const DDNS_SERVER = process.env.DDNS_SERVER || '127.0.0.1';

const TOKEN_DIR = path.join(DATA_DIR, 'tokens');
const HOSTNAME_DIR = path.join(DATA_DIR, 'hostnames');

fs.mkdirSync(TOKEN_DIR, { recursive: true });
fs.mkdirSync(HOSTNAME_DIR, { recursive: true });

const add_token_entry = async (hostname) => {
    const token = get_random_token();
    const filename = path.join(TOKEN_DIR, token);
    await fs.promises.writeFile(filename, hostname);
    return token;
};

const get_token_entry = async (token) => {
    if (!token.match(/^[a-f0-9]{32}$/i)) {
        throw new Error("Invalid token");
    }
    const filename = path.join(TOKEN_DIR, token);
    const hostname = await fs.promises.readFile(filename, "utf8");
    return hostname.trim();
};

const delete_token_entry = async (token) => {
    if (!token.match(/^[a-f0-9]{32}$/i)) {
        throw new Error("Invalid token");
    }
    const filename = path.join(TOKEN_DIR, token);
    await fs.promises.unlink(filename);
};

const add_hostname_entry = async (hostname) => {
    const filename = path.join(HOSTNAME_DIR, hostname);
    await fs.promises.writeFile(filename, "");
};

const delete_hostname_entry = async (hostname) => {
    const filename = path.join(HOSTNAME_DIR, hostname);
    await fs.promises.unlink(filename);
};

const has_hostname_entry = async (hostname) => {
    const filename = path.join(HOSTNAME_DIR, hostname);
    try {
        await fs.promises.access(filename);
        return true;
    } catch (e) {
        return false;
    }
};

const execute_nsupdate = (input) => {
    return new Promise((resolve, reject) => {
        const nsupdate = child_process.spawn("nsupdate", []);
        nsupdate.on("error", (err) => {
            reject(err);
        });
        nsupdate.on("exit", (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`nsupdate exited with code ${code} and signal ${signal}`));
            }
        });
        nsupdate.stdin.write(input);
        nsupdate.stdin.end();
    });
};

const get_random_token = () => {
    const buffer = Buffer.alloc(16);
    crypto.randomFillSync(buffer);
    return buffer.toString("hex");
};

const validate_hostname = (hostname) => {
    const lower_hostname = String(hostname).toLowerCase();
    if (!lower_hostname.match(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i)) {
        throw new Error("Invalid hostname");
    }
    return lower_hostname;
};

const validate_ip_address = (ip, version) => {
    const lower_ip = String(ip).toLowerCase();
    const ip_version = net.isIP(lower_ip);
    if (version != ip_version) {
        throw new Error(`Invalid IP address for version ${version}`);
    }
    return lower_ip;
};

const create_a_record = async (hostname, ip) => {
    const lower_hostname = validate_hostname(hostname);
    const lower_ip = validate_ip_address(ip, 4);
    const input = `server ${DDNS_SERVER}
zone ${DDNS_ZONE}
update delete ${lower_hostname}.${DDNS_ZONE} IN A
update add ${lower_hostname}.${DDNS_ZONE} 60 IN A ${lower_ip}
send
`;
    await execute_nsupdate(input);
};

const create_aaaa_record = async (hostname, ip) => {
    const lower_hostname = validate_hostname(hostname);
    const lower_ip = validate_ip_address(ip, 6);
    const input = `server ${DDNS_SERVER}
zone ${DDNS_ZONE}
update delete ${lower_hostname}.${DDNS_ZONE} IN AAAA
update add ${lower_hostname}.${DDNS_ZONE} 60 IN AAAA ${lower_ip}
send
`;
    await execute_nsupdate(input);
};

const delete_records = async (hostname) => {
    const lower_hostname = validate_hostname(hostname);
    const input = `server ${DDNS_SERVER}
zone ${DDNS_ZONE}
update delete ${lower_hostname}.${DDNS_ZONE} IN A
update delete ${lower_hostname}.${DDNS_ZONE} IN AAAA
send
`;
    await execute_nsupdate(input);
};

const create_json_response = (res, json_data) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(json_data));
};

const parse_post_data = (req) => {
    if (req.method !== 'POST') {
        throw new Error("Invalid method");
    }
    let body = '';
    req.on('data', (chunk) => {
        body += chunk;

        if (body.length > 1e6) {
            req.connection.destroy();
        }
    });

    return new Promise((resolve, reject) => {
        req.on('end', () => {
            try {
                resolve(new URLSearchParams(body));
            } catch (e) {
                reject(e);
            }
        });
    });
};

/**
 * Parse GET or POST data.
 * @param {http.IncomingMessage} req 
 * @returns 
 */
const parse_form_data = async (req) => {
    if (req.method !== 'POST') {
        return new URLSearchParams(req.url.split('?').slice(1).join('?'));
    }
    return parse_post_data(req);
};

/**
 * Creates a new DDNS record.
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse<http.IncomingMessage>} res 
 */
const service_create = async (req, res) => {
    const query = await parse_form_data(req);
    const hostname = query.get("hostname");
    if (!hostname) {
        throw new Error("You must provide hostname");
    }
    if (await has_hostname_entry(hostname)) {
        throw new Error("Hostname already exists");
    }
    // await create_a_record(hostname, '127.0.0.1');
    // await create_aaaa_record(hostname, '::1');
    const token = await add_token_entry(hostname);
    await add_hostname_entry(hostname);
    create_json_response(res, {
        "error": null,
        "token": token,
    });
};

/**
 * Updates a DDNS record.
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse<http.IncomingMessage>} res 
 */
const service_update = async (req, res) => {
    const query = await parse_form_data(req);
    const token = query.get("token");
    if (!token) {
        throw new Error("You must provide token");
    }
    const ip = String(query.get("ip") || req.headers['x-real-ip'] || req.socket.remoteAddress).trim();
    const hostname = await get_token_entry(token);
    const has_hostname = await has_hostname_entry(hostname);
    if (!has_hostname) {
        throw new Error("Invalid token");
    }
    const result = {
        "error": null,
    };
    switch (net.isIP(ip)) {
        case 4:
            await create_a_record(hostname, ip);
            result.a = ip;
            break;
        case 6:
            await create_aaaa_record(hostname, ip);
            result.aaaa = ip;
            break;
        default:
            throw new Error("Invalid IP address");
    }
    create_json_response(res, result);
};

const service_delete = async (req, res) => {
    const query = await parse_form_data(req);
    const token = query.get("token");
    if (!token) {
        throw new Error("You must provide token");
    }
    const hostname = await get_token_entry(token);
    await delete_records(hostname);
    await delete_token_entry(token);
    await delete_hostname_entry(hostname);
    create_json_response(res, {
        "error": null,
    });
};

const server = http.createServer(async (req, res) => {
    const [url] = req.url.split("?");
    try {
        if (url === "/create") {
            await service_create(req, res);
            return;
        }
        if (url === "/update") {
            await service_update(req, res);
            return;
        }
        if (url === "/delete") {
            await service_delete(req, res);
            return;
        }
        throw new Error("Invalid URL");
    } catch (e) {
        console.error(e);
        res.statusCode = 400;
        create_json_response(res, {
            "error": e?.message ?? String(e),
        });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
});
