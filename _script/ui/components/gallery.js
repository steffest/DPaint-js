import $ from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND} from "../../enum.js";
import ImageFile from "../../image.js";

let Gallery = (()=>{
    let me = {};
    let container;
    let listContainer;
    let firstItem;
    let openFirstItem;

    // Content generator for the free-panel system: renders the gallery list into the
    // panel's content area (the panel chrome/caption/close is owned by PanelManager).
    me.generate = function(parent){
        container = $(".gallery",{parent:parent}, listContainer = $(".list"));
        list();
        return container;
    }

    // Open the first gallery item once the list has loaded (used by deep-link/autoplay).
    me.openFirst = function(){
        if (firstItem) openItem(firstItem); else openFirstItem = true;
    }

    function list(){
        fetch("./gallery/gallery.json").then(response=>response.json()).then(data=>{
            listContainer.innerHTML = "";

            data.forEach(item=>{
                if (item.url){
                    if (!firstItem) firstItem = item;
                    let thumb;
                    $(".item",{
                            parent:listContainer,
                            onClick:()=>{
                                openItem(item);
                            }},
                        thumb = $(".thumb"),
                        $(".fileinfo",
                            $(".title",item.title),
                            item.artistUrl
                                ? $("a.artist",{href:item.artistUrl, target:"_blank"},item.artist)
                                : $(".artist",item.artist),
                            $(".year",item.year)
                        ))
                    ;
                    thumb.style.backgroundImage = "url('" + item.image +"')";
                }else{
                    $(".section",{parent:listContainer}
                        ,item.title ? $(".title",item.title): ""
                        ,$(".description",item.description));
                }
            });
            if (openFirstItem){
                openItem(firstItem);
                openFirstItem = false;
            }
        }).catch(err=>{
            console.error(err);
        });
    }

    function openItem(item){
        ImageFile.openUrl(item.url).then(()=>{
            setTimeout(()=>{
                EventBus.trigger(COMMAND.ZOOMFIT);
                if (item.cycle){
                    setTimeout(()=>{
                        EventBus.trigger(COMMAND.CYCLEPALETTE);
                    },200);
                }
                if (item.generatePalette){
                    EventBus.trigger(COMMAND.PALETTEFROMIMAGE);
                }

                // update the url
                let url = new URL(window.location.href);
                url.searchParams.delete("gallery");
                url.searchParams.set("file",item.url);
                url.searchParams.set("zoom","1");
                if (item.cycle){
                    url.searchParams.set("play","1");
                }else{
                    url.searchParams.delete("play");
                }
                if (item.generatePalette){
                    url.searchParams.set("palette","1");
                }else{
                    url.searchParams.delete("palette");
                }
                url.search = decodeURIComponent(url.search);
                window.history.pushState({},"",url);
            },200);
        }).catch((err)=>{});
    }


    return me;

});

export default Gallery();