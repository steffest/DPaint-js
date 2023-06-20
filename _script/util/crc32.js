let CRC32 = function(){

    let me = {};

    let crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++){
        let c = n;
        for (let k = 0; k < 8; k++){
            if (c & 1){
                c = 0xedb88320 ^ (c >>> 1);
            }else{
                c = c >>> 1;
            }
        }
        crcTable[n] = c;
    }

    me.get= function(data){
        let crc = 0xffffffff;
        for (let i = 0; i < data.length; i++){
            crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
        }
        return crc ^ 0xffffffff;
    }

    return me;

}()

export default CRC32;