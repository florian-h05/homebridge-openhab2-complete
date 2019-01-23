'use strict';

let Characteristic, Service;

let getAccessoryInformationService = require('util/Util').getAccessoryInformationService;

class LightAccessory {

    constructor(platform, config) {
        this._log = platform["log"];
        this._log.debug(`Creating new light accessory: ${config.name}`);

        Characteristic = platform["api"].hap.Characteristic;
        Service = platform["api"].hap.Service;

        this._config = config;
        this._openHAB = platform["openHAB"];
        this.name = config.name;
        this.uuid_base = config.serialNumber;

        if(!(this._config.habItem)) {
            throw new Error(`Required habItem not defined: ${util.inspect(acc)}`)
        } else {
            this._habItem = config.habItem;
        }

        this._type = this._openHAB.getItemType(this._habItem);
        if(this._type instanceof Error) {
            throw this._type;
        } else if(!(this._type === "Switch" ||
            this._type === "Dimmer" ||
            this._type === "Color")) {
            throw new Error(`${this._habItem}'s type (${this._type}) is not as expected ('Switch', 'Dimmer' or 'Color')`);
        }

        // Synchronisation helper
        this._stateLock = false; // This lock will guard the acceptance of new states
        this._commitLock = false; // This lock will guard the commit process

        this._newState = {
            binary: undefined,
            hue: undefined,
            saturation: undefined,
            brightness: undefined
        };

        this._services = [
            getAccessoryInformationService(platform, config, 'openHAB2 Light'),
            this._getLightbulbService()
        ];

    }

    // Called by homebridge
    identify(callback) {
        this._log.debug(`Identify request received!`);
        callback();
    }

    // Called by homebridge
    getServices() {
        this._log.debug("Getting services");
        return this._services;
    }

    _getLightbulbService() {
        this._log.debug(`Creating lightbulb service for ${this.name}/${this._habItem}`);
        this._mainService = new Service.Lightbulb(this.name);

        switch (this._type) {
            case "Color": // Color has Saturation, Hue, Brightness and On Characteristic (fall through intended)
                this._mainService.getCharacteristic(Characteristic.Saturation)
                    .on('set', this._setState.bind(this, "saturation"))
                    .on('set', this._commitState.bind(this))
                    .on('get', this._getState.bind(this, "saturation"));

                this._mainService.getCharacteristic(Characteristic.Hue)
                    .on('set', this._setState.bind(this, "hue"))
                    .on('set', this._commitState.bind(this))
                    .on('get', this._getState.bind(this, "hue"));
            case "Dimmer": // Dimmer has Brightness and On Characteristic (fall through intended)
                this._mainService.getCharacteristic(Characteristic.Brightness)
                    .on('set', this._setState.bind(this, "brightness"))
                    .on('set', this._commitState.bind(this))
                    .on('get', this._getState.bind(this, "brightness"));
            case "Switch": // Switch only has ON Characteristic
                this._mainService.getCharacteristic(Characteristic.On)
                    .on('set', this._setState.bind(this, "binary"))
                    .on('set', this._commitState.bind(this))
                    .on('get', this._getState.bind(this, "binary"));
                break;
        }
        return this._mainService;
    }

    _getState(stateType, callback) {
        this._log.debug(`Getting state of ${this.name} [${this._habItem}]`);
        this._openHAB.getState(this._habItem, function(error, state) {
            if(error) {
                this._log.error(`Unable to get state: ${error.message}`);
                callback(error);
            } else {
                this._log(`Received state: ${state} for ${this.name} [${this._habItem}]`);

                switch(stateType) {
                    case "binary": // expects true or false
                        if(this._type === "Switch") {
                            callback(null, state === "ON");
                        } else if (this._type === "Dimmer") {
                            callback(null, state > 0);
                        } else if (this._type === "Color") {
                            callback(null, state.split(",")[2] > 0);
                        } else {
                            callback (new Error(`Unable to parse binary state: ${state}`));
                        }
                        break;
                    case "brightness": // expects number and only called by dimmer or color types
                        if(this._type === "Dimmer") {
                            callback(null, state);
                        } else if(this._type === "Color") {
                            callback(null, state.split(",")[2]);
                        } else {
                            callback (new Error(`Unable to parse brightness state: ${state}`));
                        }
                        break;
                    case "hue": // expects number and only called by color types
                        if(this._type ===  "Color") {
                            callback(null, state.split(",")[0]);
                        } else {
                            callback (new Error(`Unable to parse hue state: ${state}`));
                        }
                        break;
                    case "saturation": // expects number and only called by color types
                        if(this._type ===  "Color") {
                            callback(null, state.split(",")[1]);
                        } else {
                            callback (new Error(`Unable to parse saturation state: ${state}`));
                        }
                        break;
                    default:
                        callback(new Error(`${stateType} unknown`));
                        break;
                }
            }
        }.bind(this));
    }

    // Set the state unless it's locked
    _setState(stateType, value) {
        this._log.debug(`Change ${stateType} target state of ${this.name} [${this._habItem}] to ${value}`);
        if (!(this._stateLock)) {
            this._newState[stateType] = value;
        }
    }

    // Wait for all states to be set (250ms should be sufficient) and then commit once
    _commitState(_, callback) {
        if(this._commitLock) {
            this._log.debug(`Not executing commit due to commit lock`);
            callback();
        } else {
            this._commitLock = true;
            setTimeout(function () {
                this._stateLock = true;
                let command;
                if(this._newState["brightness"] === undefined && this._newState["hue"] === undefined && this._newState["saturation"] === undefined) {           // Only binary set
                    if(this._newState["binary"] === undefined) {
                        command = new Error("Race condition! Commit was called before set!")
                    } else {
                        command = this._newState["binary"] ? "ON" : "OFF";
                    }
                } else if(this._newState["hue"] === undefined && this._newState["saturation"] === undefined) {                                                  // Only brightness set
                    if (this._newState["brightness"] === undefined) {
                        command = new Error("Race condition! Commit was called before set!");
                    } else {
                        command = `${this._newState["brightness"] === 100 ? 99 : this._newState["brightness"]}`;
                    }
                } else {                                                                                                                                         // Either hue, brightness and/or saturation set, therefore we need to send a tuple
                    if(this._newState["hue"] !== undefined && this._newState["brightness"] !== undefined && this._newState["saturation"] !== undefined) {        // All states set, no need to get missing information
                        command = `${this._newState["hue"]},${this._newState["saturation"]},${this._newState["brightness"]}`;
                    } else {                                                                                                                                     // Not all states set , therefore we need to get the current state, in order to get the complete tuple
                        let state = this._openHAB.getStateSync(this._habItem);
                        if (!(state)) {
                            command = new Error("Unable to retrieve current state");
                        } else if (state instanceof Error) {
                            command = state;
                        } else {
                            let splitState = state.split(",");
                            command = `${this._newState["hue"] === undefined ? splitState[0] : this._newState["hue"]},\
                                ${this._newState["saturation"] === undefined ? splitState[1] : this._newState["saturation"]},\
                                ${this._newState["brightness"] === undefined ? splitState[2] : this._newState["brightness"]}`.replace(/\s*/g, "");
                        }
                    }
                }
                this._releaseLocks();
                if(command) {
                    if(command instanceof Error) {
                        this._log.error(command.message);
                        callback(command);
                    } else {
                        this._log(`Updating state of ${this.name} [${this._habItem}] to ${command}`);
                        this._openHAB.sendCommand(this._habItem, command , callback);
                    }
                } else {
                    callback(new Error("Command was not set"));
                }
            }.bind(this), 250);
        }
    }

    _releaseLocks() {
        this._log.debug(`Cleaning up and releasing locks`);
        this._newState = {
            binary: undefined,
            hue: undefined,
            saturation: undefined,
            brightness: undefined
        };
        this._commitLock = false;
        this._stateLock = false;
    }
}

module.exports = LightAccessory;