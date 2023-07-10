let LZW = function() {

    var me = {};

    me.encode= function(pixels, imgWidth, imgHeight, color_depth) {
        // adapted from https://github.com/antimatter15/jsgif/blob/master/LZWEncoder.js
        // MIT License
        // Copyright (c) 2010-2014 Kevin Kwok <antimatter15@gmail.com>

        var EOF = -1;
        var initCodeSize;
        var remaining;
        var curPixel;
        var BITS = 12;
        var HSIZE = 5003; // 80% occupancy
        var n_bits; // number of bits/code
        var maxbits = BITS; // user settable max # bits/code
        var maxcode; // maximum code, given n_bits
        var maxmaxcode = 1 << BITS; // should NEVER generate this code
        var htab = [];
        var codetab = [];
        var hsize = HSIZE; // for dynamic table sizing
        var free_ent = 0; // first unused entry
        var clear_flg = false;
        var g_init_bits;
        var ClearCode;
        var EOFCode;
        var cur_accum = 0;
        var cur_bits = 0;
        var masks = [0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F, 0x00FF, 0x01FF, 0x03FF, 0x07FF, 0x0FFF, 0x1FFF, 0x3FFF, 0x7FFF, 0xFFFF];
        var a_count;


        var accum = [];


        initCodeSize = Math.max(2, color_depth);

        let out = [];
        out.push(initCodeSize); // write "initial code size" byte

        remaining = imgWidth * imgHeight; // reset navigation variables
        curPixel = 0;
        compress(initCodeSize + 1, out); // compress and write the pixel data
        //os.writeByte(0); // write block terminator
        out.push(0); // write block terminator

        return out;


        // Add a character to the end of the current packet, and if it is 254
        // characters, flush the packet to disk.
        function char_out(c, outs) {
            accum[a_count++] = c;
            if (a_count >= 254) flush_char(outs);
        };

        // Clear out the hash table
        // table clear for block compress

        function cl_block(outs) {
            cl_hash(hsize);
            free_ent = ClearCode + 2;
            clear_flg = true;
            output(ClearCode, outs);
        };

        // reset code table
        function cl_hash(hsize) {
            for (var i = 0; i < hsize; ++i) htab[i] = -1;
        };

        function compress(init_bits, outs) {

            var fcode;
            var i; /* = 0 */
            var c;
            var ent;
            var disp;
            var hsize_reg;
            var hshift;

            // Set up the globals: g_init_bits - initial number of bits
            g_init_bits = init_bits;

            // Set up the necessary values
            clear_flg = false;
            n_bits = g_init_bits;
            maxcode = MAXCODE(n_bits);

            ClearCode = 1 << (init_bits - 1);
            EOFCode = ClearCode + 1;
            free_ent = ClearCode + 2;

            a_count = 0; // clear packet

            ent = nextPixel();

            hshift = 0;
            for (fcode = hsize; fcode < 65536; fcode *= 2)
                ++hshift;
            hshift = 8 - hshift; // set hash code range bound

            hsize_reg = hsize;
            cl_hash(hsize_reg); // clear hash table

            output(ClearCode, outs);

            outer_loop: while ((c = nextPixel()) != EOF) {
                fcode = (c << maxbits) + ent;
                i = (c << hshift) ^ ent; // xor hashing

                if (htab[i] == fcode) {
                    ent = codetab[i];
                    continue;
                }

                else if (htab[i] >= 0) { // non-empty slot

                    disp = hsize_reg - i; // secondary hash (after G. Knott)
                    if (i === 0) disp = 1;

                    do {
                        if ((i -= disp) < 0)
                            i += hsize_reg;

                        if (htab[i] == fcode) {
                            ent = codetab[i];
                            continue outer_loop;
                        }
                    } while (htab[i] >= 0);
                }

                output(ent, outs);
                ent = c;
                if (free_ent < maxmaxcode) {
                    codetab[i] = free_ent++; // code -> hashtable
                    htab[i] = fcode;
                }
                else cl_block(outs);
            }

            // Put out the final code.
            output(ent, outs);
            output(EOFCode, outs);
        };

        // ----------------------------------------------------------------------------



        // Flush the packet to disk, and reset the accumulator
        function flush_char(outs) {
            if (a_count > 0) {
                if (outs.writeByte){
                    outs.writeByte(a_count);
                    for (var i = 0; i < a_count; i++){
                        outs.writeByte(accum[i]);
                    }
                }else{
                    outs.push(a_count);
                    for (var i = 0; i < a_count; i++){
                        outs.push(accum[i]);
                    }
                }
                a_count = 0;
            }
        };

        function MAXCODE(n_bits) {
            return (1 << n_bits) - 1;
        };

        // ----------------------------------------------------------------------------
        // Return the next pixel from the image
        // ----------------------------------------------------------------------------

        function nextPixel() {
            if (remaining === 0) return EOF;
            --remaining;
            var pix = pixels[curPixel++];
            return pix & 0xff;
        };

        function output(code, outs) {

            cur_accum &= masks[cur_bits];

            if (cur_bits > 0) cur_accum |= (code << cur_bits);
            else cur_accum = code;

            cur_bits += n_bits;

            while (cur_bits >= 8) {
                char_out((cur_accum & 0xff), outs);
                cur_accum >>= 8;
                cur_bits -= 8;
            }

            // If the next entry is going to be too big for the code size,
            // then increase it, if possible.

            if (free_ent > maxcode || clear_flg) {

                if (clear_flg) {

                    maxcode = MAXCODE(n_bits = g_init_bits);
                    clear_flg = false;

                } else {

                    ++n_bits;
                    if (n_bits == maxbits) maxcode = maxmaxcode;
                    else maxcode = MAXCODE(n_bits);
                }
            }

            if (code == EOFCode) {

                // At EOF, write the rest of the buffer.
                while (cur_bits > 0) {
                    char_out((cur_accum & 0xff), outs);
                    cur_accum >>= 8;
                    cur_bits -= 8;
                }

                flush_char(outs);
            }
        }
    }



    me.decode = function(data, minCodeSize, pixelCount){
        // adapted from https://github.com/matt-way/gifuct-js
        // MIT license
        // Copyright (c) 2015 Matt Way

        const MAX_STACK_SIZE = 4096;
        const nullCode = -1;
        const npix = pixelCount;
        let available, clear, code_mask, code_size, end_of_information, in_code, old_code, code, i, data_size;

        const dstPixels = new Array(pixelCount);
        const prefix = new Array(MAX_STACK_SIZE);
        const suffix = new Array(MAX_STACK_SIZE);
        const pixelStack = new Array(MAX_STACK_SIZE + 1);

        // Initialize GIF data stream decoder.
        data_size = minCodeSize;
        clear = 1 << data_size;
        end_of_information = clear + 1;
        available = clear + 2;
        old_code = nullCode;
        code_size = data_size + 1;
        code_mask = (1 << code_size) - 1;
        for (code = 0; code < clear; code++) {
            prefix[code] = 0;
            suffix[code] = code;
        }

        // Decode GIF pixel stream.
        let datum, bits, count, first, top, pi, bi
        datum = bits = count = first = top = pi = bi = 0;
        for (i = 0; i < npix; ) {
            if (top === 0) {
                if (bits < code_size) {
                    // get the next byte
                    datum += data[bi] << bits;
                    bits += 8;
                    bi++;
                    continue;
                }
                // Get the next code.
                code = datum & code_mask;
                datum >>= code_size;
                bits -= code_size;
                // Interpret the code
                if (code > available || code == end_of_information) break;
                if (code == clear) {
                    // Reset decoder.
                    code_size = data_size + 1;
                    code_mask = (1 << code_size) - 1;
                    available = clear + 2;
                    old_code = nullCode;
                    continue;
                }
                if (old_code == nullCode) {
                    pixelStack[top++] = suffix[code];
                    old_code = code;
                    first = code;
                    continue;
                }
                in_code = code;
                if (code == available) {
                    pixelStack[top++] = first;
                    code = old_code;
                }
                while (code > clear) {
                    pixelStack[top++] = suffix[code];
                    code = prefix[code];
                }

                first = suffix[code] & 0xff;
                pixelStack[top++] = first;

                // add a new string to the table, but only if space is available
                // if not, just continue with current table until a clear code is found
                // (deferred clear code implementation as per GIF spec)
                if (available < MAX_STACK_SIZE) {
                    prefix[available] = old_code;
                    suffix[available] = first;
                    available++;
                    if ((available & code_mask) === 0 && available < MAX_STACK_SIZE) {
                        code_size++;
                        code_mask += available;
                    }
                }
                old_code = in_code;
            }
            // Pop a pixel off the pixel stack.
            top--;
            dstPixels[pi++] = pixelStack[top];
            i++;
        }

        for (i = pi; i < npix; i++) {
            dstPixels[i] = 0; // clear missing pixels
        }

        return dstPixels;
    }


    return me;
};

export default LZW();